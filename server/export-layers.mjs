// Layers export, timeline files and motion data (the Export panel's Layers and Timeline file kinds).
//
// Layers: every layer of the canvas export as its own file, all on the export's timeline (after the locked cut and
// the blocks), all starting at 0:00 and the same length, so they stack in any editor: the background, each card
// (screen, camera, extra takes: shadow + picture + border, transparent around it), the scene's graphics layers (or
// every Octopus.el element on its own), the presenter cut out with the project's masks, the voice and the sound cues.
// Transparent layers are ProRes 4444 with alpha, opaque ones ProRes 422 HQ (or H.264 for smaller files). The
// cards are cut and placed with the same filter chains as server/export.mjs and the same canvas PNGs, so the stack
// gives the MP4 back. Output: renders/<project>_layers_vN/ with README.txt (order, rate), layers.json, motion.json
// and the timeline files. Timeline file: the same FCPXML / FCP 7 XML straight from the sources, no rendering.
//
// Shots: a take part whose shots change the look is cut into one video part per run of one
// look (plan.vparts), so each card follows its shot: the crop, zoom, focus, box and border of that shot, and an empty
// (transparent) stretch where the shot hides it. Shot changes are cuts in these files: a crossfade isn't baked in
// (layers.json "transitions" and the README list them, to add in the editor). The sound stays per section part. The
// timeline file is cut at every shot change too (its clips are the raw recordings, so the looks themselves aren't in it).
import { spawn, execFile } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join, relative, basename, extname } from 'node:path';
import { studioTool, writeJSON, readJSON, settings, h264, videoDecodeArgs } from './util.mjs';
import { roles as projectRoles, probe, lockedCut, appendWorklog, projectMeta } from './studio.mjs';
import { exportInfo } from './export.mjs';
import { backgroundPlan, logTrialUse } from './backgrounds.mjs';
import { mixCues, underVoiceDb } from './sound.mjs';
import { sequenceForExport } from './blocks.mjs';
import { readProduction, overridesDoc } from './scenes.mjs';
import { openScene, blankPng } from './scene-frames.mjs';
import { fcpxml, xmeml, mediaInfo, rateOf, sourcesSpec } from './timeline-file.mjs';
import { compose, normalize, snapSegments, FPS, PRESETS } from '../web/layout.js';
import { blockLayout } from '../web/blockseq.js';
import { readShots } from './shots.mjs';
import { keptShots, planTakePart, sceneKey } from '../web/exportshots.js';
import { startShift } from './export-shots.mjs';

const jobs = new Map(); // project id -> running layers / timeline job
export const layersBusy = () => jobs.size > 0;
const HEAD = ['-y', '-v', 'error', '-nostats', '-progress', 'pipe:1'];
const COLOR = ['-colorspace', 'bt709', '-color_primaries', 'bt709', '-color_trc', 'bt709', '-color_range', 'tv'];
const ENC = {
  alpha: { tail: 'scale=out_color_matrix=bt709:out_range=tv,format=yuva444p10le', args: ['-c:v', 'prores_ks', '-profile:v', '4444', '-pix_fmt', 'yuva444p10le', '-alpha_bits', '16', '-vendor', 'apl0', ...COLOR], label: 'ProRes 4444 with alpha' },
  hq: { tail: 'scale=out_color_matrix=bt709:out_range=tv,format=yuv422p10le', args: ['-c:v', 'prores_ks', '-profile:v', '3', '-pix_fmt', 'yuv422p10le', '-vendor', 'apl0', ...COLOR], label: 'ProRes 422 HQ' },
  h264: { tail: 'scale=out_color_matrix=bt709:out_range=tv,format=yuv420p', args: [...h264('24M'), '-profile:v', 'high', '-tag:v', 'avc1', ...COLOR], label: 'H.264' },
};
const two = (v) => String(v).padStart(2, '0');
const slug = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'x';
const clock = (t) => { t = Math.max(0, t || 0); const m = Math.floor(t / 60); return `${m}:${(t % 60).toFixed(2).padStart(5, '0')}`; };
const secs = (n) => (n / FPS).toFixed(6);

export const layersRunning = (id) => jobs.has(id);

// ---- what the panel shows: the scene's graphics layers, the masks, the next folder names, earlier exports ----
function sceneFile(dir) {
  const prod = readProduction(dir);
  const file = [prod?.sceneFile, 'scene.html', 'scenes.html', 'work/scene.html'].find((f) => f && !f.includes('..') && existsSync(join(dir, f)));
  if (!file) return null;
  let text = '';
  try { text = readFileSync(join(dir, file), 'utf8'); } catch {}
  const layers = /Octopus\.layers\s*=\s*\[([^\]]*)\]/.exec(text)?.[1].split(',').map((x) => x.trim().replace(/^['"]|['"]$/g, '')).filter(Boolean);
  return { file, kit: /octopus-scene\.js/.test(text), layers: layers?.length ? layers : [null], elements: (text.match(/Octopus\.el\(\s*['"][\w.-]+['"]/g) || []).length + (text.match(/data-studio=/g) || []).length };
}

// The presenter's matte: a folder of numbered PNGs (masks/, masks6/, work/masks…) with one frame per camera frame.
export function findMasks(dir, camFile) {
  const p = camFile && probe(dir, camFile);
  if (!p?.fps) return null;
  const want = Math.round(p.duration * p.fps);
  const found = [];
  for (const base of ['', 'work']) {
    let names = [];
    try { names = readdirSync(join(dir, base)); } catch {}
    for (const d of names) {
      if (!/^masks?([_-]?[\w-]*)?$/i.test(d)) continue;
      const rel = base ? `${base}/${d}` : d;
      let files = [];
      try { if (!statSync(join(dir, rel)).isDirectory()) continue; files = readdirSync(join(dir, rel)).filter((f) => /^\d+\.png$/i.test(f)); } catch { continue; }
      if (!files.length || Math.abs(files.length - want) > 2) continue;
      const digits = files[0].length - 4;
      const start = Math.min(...files.map((f) => parseInt(f, 10)));
      found.push({ dir: rel, count: files.length, digits, start, at: statSync(join(dir, rel)).mtimeMs, w: 0, h: 0 });
    }
  }
  const m = found.sort((a, b) => b.at - a.at)[0];
  if (!m) return null;
  const first = join(dir, m.dir, `${String(m.start).padStart(m.digits, '0')}.png`);
  try { const b = readFileSync(first).subarray(0, 24); m.w = b.readUInt32BE(16); m.h = b.readUInt32BE(20); } catch {}
  return { ...m, rate: rateOf(p.fps), frames: want, file: camFile };
}

function nextFolder(dir, id, kind) {
  let n = 1;
  try {
    for (const f of readdirSync(join(dir, 'renders'))) {
      const m = new RegExp(`^${id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}_${kind}_v(\\d+)$`).exec(f);
      if (m) n = Math.max(n, Number(m[1]) + 1);
    }
  } catch {}
  return `renders/${id}_${kind}_v${n}`;
}

export function layersInfo(id, dir) {
  const info = exportInfo(id, dir);
  const scene = sceneFile(dir);
  const masks = info.sources.cam ? findMasks(dir, info.sources.cam) : null;
  let cues = 0;
  try { cues = (readJSON(join(dir, 'work/sfx.json'), {})?.cues || []).length; } catch {}
  let blocks = null;
  try { const seq = sequenceForExport(dir, { useCut: true }); if (seq) blocks = seq.parts.length; } catch (e) { blocks = { error: e.message }; }
  return {
    scene: scene ? { file: scene.file, kit: scene.kit, layers: scene.layers, elements: scene.elements, production: Boolean(readProduction(dir)) } : null,
    masks: masks ? { dir: masks.dir, count: masks.count } : null,
    cues, blocks, next: { layers: nextFolder(dir, id, 'layers'), timeline: nextFolder(dir, id, 'timeline') },
    exports: listLayerExports(dir), running: jobs.get(id)?.last || null,
  };
}

// Earlier layers and timeline exports, for the Renders tab's cards (renders/<id>_layers_vN/, …_timeline_vN/).
export function listLayerExports(dir) {
  let names = [];
  try { names = readdirSync(join(dir, 'renders')); } catch { return []; }
  return names.filter((n) => /_(layers|timeline)_v\d+$/.test(n)).flatMap((n) => {
    const p = join(dir, 'renders', n);
    try {
      if (!statSync(p).isDirectory()) return [];
      const files = readdirSync(p).filter((f) => !f.startsWith('.'));
      const bytes = files.reduce((t, f) => t + (statSync(join(p, f)).size || 0), 0);
      const man = readJSON(join(p, 'layers.json'), null);
      return [{ folder: `renders/${n}`, name: n, kind: /_timeline_v\d+$/.test(n) ? 'timeline' : 'layers', at: statSync(p).mtimeMs, bytes, files: files.length,
        video: man?.video?.length || 0, audio: man?.audio?.length || 0, duration: man?.duration || null, fps: man?.rate || null, timeline: files.some((f) => f.endsWith('.fcpxml')) }];
    } catch { return []; }
  }).sort((a, b) => b.at - a.at);
}

// ---- the plan: the export's parts (one for a plain export, one per block run otherwise) ----
function pngFrom(dataUrl, w, h, what) {
  const m = /^data:image\/png;base64,(.+)$/.exec(dataUrl || '');
  if (!m) throw new Error(`Missing the ${what} layer from the canvas.`);
  const buf = Buffer.from(m[1], 'base64');
  if (buf.length < 24 || buf.toString('latin1', 12, 16) !== 'IHDR') throw new Error(`The ${what} layer isn't a PNG.`);
  const pw = buf.readUInt32BE(16), ph = buf.readUInt32BE(20);
  if (pw !== w || ph !== h) throw new Error(`The ${what} layer is ${pw}×${ph}, expected ${w}×${h}. Reload the page and try again.`);
  return buf;
}

export function planParts(id, dir, body) {
  const meta = projectMeta(dir);
  const layout = normalize(body.layout || meta?.layout, meta?.type);
  const info = exportInfo(id, dir);
  if (!info.duration) throw new Error('Nothing to export yet: add a recording first.');
  const useCut = body.useCut !== false;
  const cut = info.cut ? lockedCut(dir) : null;
  const cutSegs = cut ? snapSegments(cut.segments, info.duration) : null;
  const seq = body.blocks === false ? null : sequenceForExport(dir, { useCut, readOnly: body.timelineOnly === true });
  const take = { screen: info.sources.screen && `source/${info.sources.screen}`, cam: info.sources.cam && `source/${info.sources.cam}`,
    audio: info.sources.audio && `source/${info.sources.audio}` }; // audio: a mic-only take (no cards, just its sound)
  const takeSounds = () => {
    const s = [];
    if (info.audio) s.push(take[info.audio]);
    for (const x of layout.layers) if (x.audio && info.layerAudio[x.file] && !s.includes(`source/${x.file}`)) s.push(`source/${x.file}`);
    return s;
  };
  let parts;
  if (!seq) {
    const segs = useCut && cutSegs ? cutSegs : null;
    const total = segs ? segs.reduce((t, [a, b]) => t + b - a, 0) : Math.floor(info.duration * FPS) / FPS;
    parts = [{ kind: 'take', name: segs ? 'Take (locked cut)' : 'Whole take', layout, scene: compose(layout, info.dims), pngs: body.pngs, segs, total,
      src: take, dims: info.dims, sounds: takeSounds(), range: null, blocks: null }];
  } else {
    const labels = Object.fromEntries(seq.doc.blocks.map((b) => [b.id, b.label]));
    parts = seq.parts.map((p) => {
      if (p.kind === 'take') {
        const segs = snapSegments(p.segs, info.duration);
        const r = p.blocks.map((b) => seq.doc.blocks.find((x) => x.id === b)?.source.take).filter(Boolean);
        return { kind: 'take', name: p.blocks.map((b) => labels[b]).filter((v, i, a) => a.indexOf(v) === i).join(' + '), layout: p.layout ? { ...layout, preset: p.layout } : layout,
          scene: compose(p.layout ? { ...layout, preset: p.layout } : layout, info.dims), pngs: p.layout ? body.pngs?.blocks?.[p.blocks[0]] : body.pngs,
          segs, total: segs.reduce((t, [a, b]) => t + b - a, 0), src: take, dims: info.dims, sounds: takeSounds(),
          range: r.length ? [Math.min(...r.map((x) => x[0])), Math.max(...r.map((x) => x[1]))] : null, blocks: p.blocks };
      }
      const fi = p.info;
      const src = { screen: fi.files.screen && `source/${fi.files.screen}`, cam: fi.files.cam && `source/${fi.files.cam}` };
      const sound = src.cam || src.screen || (fi.files.audio && `source/${fi.files.audio}`); // a sound-only block (voiceover)
      return { kind: 'file', name: `${p.block.label} (own file)`, layout: blockLayout(layout, p.block), scene: compose(blockLayout(layout, p.block), fi.dims), pngs: body.pngs?.blocks?.[p.block.id],
        segs: null, total: Math.floor(fi.duration * FPS) / FPS, src, dims: fi.dims, sounds: fi.audio ? [sound] : [], range: null, blocks: [p.block.id] };
    });
  }
  // A sound-only block has no cards: its stretch is transparent in the card layers and its sound is in the voice.
  parts = parts.filter((p) => (p.scene.layers.length || p.sounds.length) && p.total > 0);
  if (!parts.length) throw new Error('Nothing to export yet: add a recording first.');
  let at = 0;
  parts.forEach((p, k) => { p.tag = `p${two(k)}`; p.frames = Math.round(p.total * FPS); p.start = at; at += p.frames; });
  // Text exports use only the final timeline; visual shot planning can settle and
  // write project state, so leave it to the existing video/layer export path.
  const shots = body.timelineOnly === true ? {} : shotParts(dir, { parts, layout, info, cutSegs: useCut ? cutSegs : null, pngs: body.pngs });
  return { layout, info, parts, frames: at, cutSegs, cut, useCut, seq, take, ...shots };
}

// The video parts (vparts): the parts, with each take part whose shots change the look cut into its runs of one look
// (web/exportshots.js planTakePart), each with that look's scene and canvas PNG layers (pngs.looks by sceneKey).
// Also the kept shots and the crossfades (export seconds), for layers.json and the README.
function shotParts(dir, { parts, layout, info, cutSegs, pngs }) {
  let shots = [];
  try { shots = keptShots(readShots(dir)); } catch (e) { console.error('shots:', e.message); }
  const vparts = [], transitions = [];
  if (!shots.length) return { vparts: parts, shots: [], transitions };
  const baseKey = sceneKey(compose(layout, info.dims));
  const label = (i) => `Shot ${i + 1}${shots[i]?.name ? ` (${shots[i].name})` : ''}`;
  for (const p of parts) {
    const sp = p.kind === 'take' ? planTakePart({ segs: p.segs || [[0, p.total]], shots, base: layout, cut: cutSegs, duration: info.duration }) : null;
    if (!sp?.changes) { vparts.push(p); continue; }
    sp.runs.forEach((r, j) => {
      const scene = compose(r.look, info.dims), key = sceneKey(scene);
      vparts.push({ ...p, tag: `${p.tag}s${two(j)}`, parent: p.tag, shotLabel: `${label(r.shots[0])}${r.shots.length > 1 ? `–${r.shots.at(-1) + 1}` : ''}`,
        name: `${p.name} · ${label(r.shots[0])}${r.shots.length > 1 ? `–${r.shots.at(-1) + 1}` : ''}`, layout: r.look, scene,
        pngs: pngs?.looks?.[key] || (key === baseKey ? pngs : null), segs: r.src.map(([a, b]) => [a / FPS, b / FPS]), frames: r.k1 - r.k0, total: (r.k1 - r.k0) / FPS,
        start: p.start + r.k0, seek: true, shots: r.shots.map((i) => shots[i]?.id) });
    });
    for (const x of sp.pieces) if (x.kind === 'fade') transitions.push({ type: x.type, rendered: 'cut', at: Math.round(((p.start / FPS) + x.at) * 1000) / 1000, dur: x.dur,
      start: Math.round(((p.start + x.k0) / FPS) * 1000) / 1000, end: Math.round(((p.start + x.k1) / FPS) * 1000) / 1000, from: x.from.shots.map((i) => shots[i]?.id), to: x.to.shots.map((i) => shots[i]?.id) });
  }
  return { vparts, shots, transitions };
}

// Export frame → moment on the scene's timeline (the production sheet's: the locked cut), NaN where no scene plays
// (file blocks, or parts of a whole-take export the cut removes).
function sceneTimes(plan) {
  const out = new Float64Array(plan.frames).fill(NaN);
  const cutF = plan.cutSegs ? plan.cutSegs.map(([a, b]) => [Math.round(a * FPS), Math.round(b * FPS)]) : null;
  const toCut = (sf) => {
    if (!cutF) return sf;
    let acc = 0;
    for (const [a, b] of cutF) { if (sf < a) return null; if (sf < b) return acc + sf - a; acc += b - a; }
    return null;
  };
  for (const p of plan.parts) {
    if (p.kind !== 'take') continue;
    let k = p.start;
    for (const [a, b] of p.segs ? p.segs.map(([x, y]) => [Math.round(x * FPS), Math.round(y * FPS)]) : [[0, p.frames]]) {
      for (let sf = a; sf < b; sf++, k++) { const c = toCut(sf); out[k] = c == null ? NaN : c / FPS; }
    }
  }
  return out;
}

// ---- small process helpers ----
function runFF(job, args, { cwd, onFrame, onTime, input } = {}) {
  return new Promise((resolve, reject) => {
    if (job.cancelled) return reject(new Error('stopped'));
    const proc = spawn(studioTool('ffmpeg'), args, { cwd, stdio: [input ? 'pipe' : 'ignore', 'pipe', 'pipe'] });
    job.procs.add(proc);
    let err = '';
    proc.stderr.on('data', (d) => { err = (err + d).slice(-3000); });
    proc.stdout.on('data', (d) => {
      const s = String(d);
      const f = [...s.matchAll(/frame=(\d+)/g)].pop();
      if (f && onFrame) onFrame(Number(f[1]));
      const t = [...s.matchAll(/out_time_(?:us|ms)=(\d+)/g)].pop();
      if (t && onTime) onTime(Number(t[1]) / 1e6);
    });
    proc.on('error', (e) => { job.procs.delete(proc); reject(e); });
    proc.on('exit', (code) => {
      job.procs.delete(proc);
      if (job.cancelled) return reject(new Error('stopped'));
      code === 0 ? resolve() : reject(new Error(`ffmpeg ${code}: ${err.trim().split('\n').slice(-2).join(' ')}`));
    });
    if (input) input(proc);
  });
}
function limiter(n) {
  let active = 0;
  const q = [];
  const next = () => {
    while (active < n && q.length) {
      const { fn, res, rej } = q.shift();
      active++;
      Promise.resolve().then(fn).then(res, rej).finally(() => { active--; next(); });
    }
  };
  return (fn) => new Promise((res, rej) => { q.push({ fn, res, rej }); next(); });
}

// ---- the filter chains (the same cut, crop, scale and mirror as server/export.mjs) ----
function videoChain(part, ly, inIdx, label, shift = null) {
  const p = ly.role === 'layer' ? part.dims.files[ly.file] : part.dims[ly.role];
  const cw = Math.round(ly.crop.w * p[0]), ch = Math.round(ly.crop.h * p[1]);
  const cx = 2 * Math.round((ly.crop.x * p[0]) / 2), cy = 2 * Math.round((ly.crop.y * p[1]) / 2);
  return `[${inIdx}:v]${shift ? `setpts=round(PTS+${shift}/TB)` : 'setpts=PTS-STARTPTS'},fps=${FPS}${pick(part)},crop=${cw}:${ch}:${cx}:${cy},scale=${ly.box.w}:${ly.box.h}:flags=lanczos${ly.mirror ? ',hflip' : ''},format=rgba${label}`;
}
// A shot part decodes only its stretch: the input is seeked to a second before it (and stops a second after), and its
// clock is put back on the take's (setpts=round(PTS+X/TB); see server/export-shots.mjs), so the same frames come out.
// shift(file) is that clock correction for a video file (null: no seek, the usual setpts=PTS-STARTPTS). The matte's
// image sequence starts at the image at or before X instead (-start_number), with its pts put back by that many
// ticks: seeking an image sequence at 29.97 lands a frame off.
function seekOf(job, part) {
  if (!part.seek || !part.segs?.length) return { args: [], shift: () => null, X: 0 };
  const a = part.segs[0][0], b = part.segs[part.segs.length - 1][1];
  const X = Math.max(0, Math.floor((a - 1) * 1000) / 1000);
  if (!(X > 0)) return { args: ['-t', (b + 1).toFixed(3)], shift: () => null, X: 0 };
  return { args: ['-ss', X.toFixed(3), '-t', (b - X + 1).toFixed(3)], shift: (file) => (X + (file ? startShift(job.dir, file) : 0)).toFixed(6), X };
}
const half = 0.5 / FPS;
const selOf = (part) => (part.segs ? part.segs.map(([a, b]) => `gte(t,${(a - half).toFixed(5)})*lt(t,${(b - half).toFixed(5)})`).join('+') : null);
const pick = (part) => (selOf(part) ? `,select='${selOf(part)}',setpts=N/${FPS}/TB` : '');
const fileOfLayer = (part, ly) => (ly.role === 'layer' ? `source/${ly.file}` : part.src[ly.role]);
const canvasIn = (W, H, n) => ['-f', 'lavfi', '-i', `color=c=black@0.0:s=${W}x${H}:r=${FPS}:d=${secs(n)},format=rgba`];

// One card (screen, camera or an extra take) of one part: its shadow, the picture in its shape, its border, on a
// transparent frame.
function cardArgs(job, part, i, out, enc) {
  const ly = part.scene.layers[i], { W, H } = part.scene;
  const args = [...HEAD];
  let n = 0;
  const input = (l) => { args.push(...l); return n++; };
  const png = (key) => `${job.rel}/${part.tag}_${key}.png`;
  const still = (key) => input(['-loop', '1', '-framerate', String(FPS), '-t', secs(part.frames), '-i', png(key)]);
  const sk = seekOf(job, part);
  const vIn = input([...sk.args, ...videoDecodeArgs(), '-i', fileOfLayer(part, ly)]);
  const kIn = still(`mask${i}`);
  const uIn = part.has.has(`under${i}`) ? still(`under${i}`) : null;
  const oIn = part.has.has(`over${i}`) ? still(`over${i}`) : null;
  const cIn = input(canvasIn(W, H, part.frames));
  const f = [videoChain(part, ly, vIn, '[v]', sk.shift(fileOfLayer(part, ly))), `[${kIn}:v]format=gray[k]`, '[v][k]alphamerge=shortest=1[a]'];
  let cur = `[${cIn}:v]`;
  if (uIn != null) { f.push(`${cur}[${uIn}:v]overlay=0:0:format=rgb[u]`); cur = '[u]'; }
  f.push(`${cur}[a]overlay=${ly.box.x}:${ly.box.y}:format=rgb[c]`); cur = '[c]';
  if (oIn != null) { f.push(`${cur}[${oIn}:v]overlay=0:0:format=rgb[o]`); cur = '[o]'; }
  f.push(`${cur}${ENC[enc].tail}[out]`);
  args.push('-filter_complex', f.join(';'), '-map', '[out]', ...ENC[enc].args, '-frames:v', String(part.frames), '-f', 'mov', out);
  return args;
}

// The presenter cut out of the camera: the camera card's picture with alpha = matte × the card's shape.
function matteArgs(job, part, i, masks, out) {
  const ly = part.scene.layers[i], { W, H } = part.scene;
  const p = part.dims.cam;
  const args = [...HEAD];
  let n = 0;
  const input = (l) => { args.push(...l); return n++; };
  const sk = seekOf(job, part);
  const vIn = input([...sk.args, ...videoDecodeArgs(), '-i', part.src.cam]);
  // (-t only when the stretch ends over a second before the sequence does: image2 with -t drops its very last image)
  const j0 = sk.X ? Math.floor((sk.X * masks.rate.num) / masks.rate.den + 1e-9) : 0; // images skipped (one tick each)
  const seqEnd = (masks.count * masks.rate.den) / masks.rate.num, until = part.segs?.length ? part.segs[part.segs.length - 1][1] : Infinity;
  const mT = sk.args.length && until + 1 < seqEnd - 1 ? sk.args.slice(-2) : [];
  const mIn = input(['-framerate', `${masks.rate.num}/${masks.rate.den}`, '-start_number', String(masks.start + j0), ...mT, '-i', `${masks.dir}/%0${masks.digits}d.png`]);
  const kIn = input(['-loop', '1', '-framerate', String(FPS), '-t', secs(part.frames), '-i', `${job.rel}/${part.tag}_mask${i}.png`]);
  const cIn = input(canvasIn(W, H, part.frames));
  const cw = Math.round(ly.crop.w * p[0]), ch = Math.round(ly.crop.h * p[1]);
  const cx = 2 * Math.round((ly.crop.x * p[0]) / 2), cy = 2 * Math.round((ly.crop.y * p[1]) / 2);
  const fit = masks.w && (masks.w !== p[0] || masks.h !== p[1]) ? `,scale=${p[0]}:${p[1]}:flags=bilinear` : '';
  const f = [videoChain(part, ly, vIn, '[v]', sk.shift(part.src.cam)),
    `[${mIn}:v]${j0 ? `setpts=PTS+${j0}` : 'setpts=PTS-STARTPTS'},fps=${FPS}${pick(part)},format=gray${fit},crop=${cw}:${ch}:${cx}:${cy},scale=${ly.box.w}:${ly.box.h}:flags=lanczos${ly.mirror ? ',hflip' : ''}[m]`,
    `[${kIn}:v]format=gray[k]`, '[m][k]blend=all_mode=multiply:shortest=1[mk]', '[v][mk]alphamerge=shortest=1[a]',
    `[${cIn}:v][a]overlay=${ly.box.x}:${ly.box.y}:format=rgb[c]`, `[c]${ENC.alpha.tail}[out]`];
  args.push('-filter_complex', f.join(';'), '-map', '[out]', ...ENC.alpha.args, '-frames:v', String(part.frames), '-f', 'mov', out);
  return args;
}

// A stretch where the layer has nothing (a block without that card): transparent frames.
function blankArgs(W, H, frames, enc, out) {
  return [...HEAD, ...canvasIn(W, H, frames), '-filter_complex', `[0:v]${ENC[enc].tail}[out]`, '-map', '[out]', ...ENC[enc].args, '-frames:v', String(frames), '-f', 'mov', out];
}

function soundArgs(dir, part, kind, out, { stereo }) {
  const args = [...HEAD];
  let n = 0;
  const input = (l) => { args.push(...l); return n++; };
  const f = [];
  const sel = selOf(part);
  const fmt = `aformat=sample_fmts=s32:sample_rates=48000${stereo ? ':channel_layouts=stereo' : ''}`;
  let label = null, cues = 0;
  if (kind === 'voice' && part.sounds.length) {
    part.sounds.forEach((file, i) => {
      const k = input(['-i', file]);
      f.push(`[${k}:a]aresample=48000:first_pts=0,asetnsamples=n=${48000 / FPS}:p=0` + (sel ? `,aselect='${sel}',asetpts=N/SR/TB` : '') + `[s${i}]`);
    });
    f.push(part.sounds.length > 1 ? `${part.sounds.map((_, i) => `[s${i}]`).join('')}amix=inputs=${part.sounds.length}:duration=first:normalize=0[vo]` : '[s0]anull[vo]');
    label = '[vo]';
  } else if (kind === 'cues' && part.kind === 'take') {
    const r = mixCues(dir, { f, input, segs: part.segs, total: part.total, voice: null, voiceFile: part.sounds[0]?.replace(/^source\//, ''), range: part.range });
    if (r.cues) { label = r.label; cues = r.cues; }
  }
  if (!label) {
    const k = input(['-f', 'lavfi', '-t', secs(part.frames), '-i', 'anullsrc=r=48000:cl=stereo']);
    f.push(`[${k}:a]anull[sil]`);
    label = '[sil]';
  }
  f.push(`${label}${fmt}[aout]`);
  args.push('-filter_complex', f.join(';'), '-map', '[aout]', '-c:a', 'pcm_s24le', '-t', secs(part.frames), '-f', 'wav', out);
  return { args, cues, silent: label === '[sil]' };
}

// ---- motion data: every element's times, boxes and keyframes, from what the scene kit reports ----
// A track keeps an entry where a value starts, stops or moves away from the last entry by more than its tolerance, so a
// straight line between entries stays within half a pixel (and 0.01 opacity) of every frame.
function track(tol) {
  const out = [];
  let prev = null, prevK = -2, wrote = false, anchor = null;
  const tk = (k) => Math.round((k / FPS) * 10000) / 10000;
  const near = (a, b) => a && b && b.every((x, j) => Math.abs(x - a[j]) <= tol[j]);
  return {
    push(k, v) {
      const same = prev && prevK === k - 1 && near(prev, v) && near(anchor, v);
      if (prev && !wrote && !same) out.push([tk(prevK), ...prev]);
      if (!same) { out.push([tk(k), ...v]); wrote = true; anchor = v; } else wrote = false;
      prev = v; prevK = k;
    },
    end() { if (prev && !wrote) out.push([tk(prevK), ...prev]); return out; },
  };
}
// element.keys as the README documents them: [{t, dx, dy, s, o, e?}] sorted by t, at most 64, t on the scene's timeline.
function keysOut(list) {
  if (!Array.isArray(list)) return [];
  const n = (x, d) => (Number.isFinite(Number(x)) ? Number(x) : d);
  return list.filter((k) => k && Number.isFinite(Number(k.t))).slice(0, 64)
    .map((k) => ({ t: n(k.t, 0), dx: n(k.dx, 0), dy: n(k.dy, 0), s: n(k.s, 1), o: Math.max(0, Math.min(1, n(k.o, 1))), ...(['linear', 'hold'].includes(k.e) ? { e: k.e } : {}) }))
    .sort((x, y) => x.t - y.t);
}

function motionData(plan, scene, samples, sceneT, id, dir, files, kit) {
  const prod = readProduction(dir);
  const ov = overridesDoc(dir);
  const els = new Map();
  for (const [layer, frames] of samples) {
    frames.forEach((hits, k) => {
      if (!hits) return;
      for (const [eid, label, sc, x, y, w, h, o, decl, keyed, painted] of hits) {
        let e = els.get(eid);
        if (!e) { e = { id: eid, label, layer, scenes: new Set(), spans: [], declared: null, last: -2, keyed: false, boxes: track([0.5, 0.5, 0.5, 0.5]), painted: track([0.5, 0.5, 0.5, 0.5, 0.01]), measured: false }; els.set(eid, e); }
        if (sc != null) e.scenes.add(String(sc));
        if (decl) e.declared = { in: decl[0], out: decl[1] };
        if (keyed) e.keyed = true;
        if (e.last === k - 1) e.spans.at(-1)[1] = k; else e.spans.push([k, k]);
        e.last = k;
        e.boxes.push(k, [x, y, w, h]);
        if (painted) { e.measured = true; e.painted.push(k, painted); }
      }
    });
  }
  const t = (k) => Math.round((k / FPS) * 1000) / 1000;
  const st = (k) => (Number.isFinite(sceneT[k]) ? Math.round(sceneT[k] * 1000) / 1000 : null);
  // A moment on the scene's timeline → where it plays in the export (null when the export doesn't show it).
  const exportAt = (ts) => {
    let best = -1, d = Infinity;
    for (let k = 0; k < sceneT.length; k++) { const x = Math.abs(sceneT[k] - ts); if (x < d) { d = x; best = k; } }
    return best >= 0 && d <= 0.5 / FPS + 1e-6 ? t(best) : null;
  };
  const elements = [...els.values()].map((e) => {
    // The creator's moves and keyframes for this element, per scene entry ("*" = every scene).
    const moves = {}, keysBy = {};
    for (const s of ['*', ...e.scenes]) {
      const o = ov.scenes?.[s]?.[e.id];
      if (!o) continue;
      moves[s] = { dx: o.dx || 0, dy: o.dy || 0, scale: o.scale ?? 1 };
      const ks = keysOut(o.keys);
      if (ks.length) keysBy[s] = ks;
    }
    const keyScenes = Object.keys(keysBy);
    const keys = keyScenes.length ? keysBy[keyScenes.find((s) => s !== '*') || keyScenes[0]] : null;
    return {
      id: e.id, label: e.label, layer: e.layer, scenes: [...e.scenes], seen: true,
      in: t(e.spans[0][0]), out: t(e.spans.at(-1)[1] + 1),
      spans: e.spans.map(([a, b]) => ({ in: t(a), out: t(b + 1), sceneIn: st(a), sceneOut: st(b) != null ? Math.round((sceneT[b] + 1 / FPS) * 1000) / 1000 : null })),
      declared: e.declared, file: files?.[e.id] || null,
      moves: Object.keys(moves).length ? moves : null,
      keys, keysScene: keys ? keyScenes.find((s) => s !== '*') || keyScenes[0] : null,
      keysAt: keys ? keys.map((k) => exportAt(k.t)) : null,
      ...(keyScenes.length > 1 ? { keysByScene: keysBy } : {}),
      keyed: e.keyed,
      boxes: e.boxes.end(),
      painted: e.measured ? e.painted.end() : null,
    };
  });
  // Elements with keyframes that never show in this export (keys hide them, or their moment is cut) still carry their keys.
  for (const [sc, list] of Object.entries(ov.scenes || {})) {
    for (const [eid, o] of Object.entries(list || {})) {
      const ks = keysOut(o?.keys);
      if (!ks.length || els.has(eid)) continue;
      const e = elements.find((x) => x.id === eid && x.seen === false);
      if (e) { e.keysByScene = { ...(e.keysByScene || { [e.keysScene]: e.keys }), [sc]: ks }; continue; }
      elements.push({ id: eid, label: o.label || eid, layer: null, scenes: sc === '*' ? [] : [sc], seen: false, in: null, out: null, spans: [], declared: null, file: null,
        moves: { [sc]: { dx: o.dx || 0, dy: o.dy || 0, scale: o.scale ?? 1 } }, keys: ks, keysScene: sc, keysAt: ks.map((k) => exportAt(k.t)), keyed: false, boxes: [], painted: null });
    }
  }
  // Where each production-sheet scene plays on the export timeline.
  const scenes = (prod?.scenes || []).map((s) => {
    let a = -1, b = -1;
    for (let k = 0; k < sceneT.length; k++) if (sceneT[k] >= s.start - 1e-6 && sceneT[k] < s.end - 1e-6) { if (a < 0) a = k; b = k; }
    return { id: s.id, title: s.title, start: s.start, end: s.end, exportIn: a >= 0 ? t(a) : null, exportOut: b >= 0 ? t(b + 1) : null };
  });
  return {
    v: 2, made: new Date().toISOString(), by: 'Video Octopus', project: id,
    frame: [plan.parts[0].scene.W, plan.parts[0].scene.H], fps: FPS, rate: `${FPS}/1`, frames: plan.frames, duration: t(plan.frames),
    about: [
      'Times in, out, boxes[][0], painted[][0] and keysAt are seconds on the export timeline: 0 = the first frame of every layer file. sceneIn, sceneOut and keys[].t are on the scene\'s own timeline (the production sheet\'s, the locked cut); scenes[] maps one to the other.',
      'boxes = [t, x, y, w, h]: the element\'s box as the scene declares it in Octopus.el, in frame pixels, after the creator\'s moves and keyframes. painted = [t, x, y, w, h, opacity]: what the element actually paints (scene kit 2 measures it), so the scene\'s own animation inside the element shows. Both keep an entry where a value starts, stops or moves on, so a straight line between entries stays within half a pixel (0.01 opacity) of every frame.',
      'keys = element.keys from work/overrides.json (scenes["<scene>"]["<element>"].keys): [{t, dx, dy, s, o, e?}] sorted by t; dx/dy frame pixels from where the scene draws it, s scale around its centre, o opacity 0-1 (multiplies its own), e "linear" | "hold" (absent = ease in and out). keysScene = the scene entry they come from ("*" = every scene); keysByScene when several have keys. moves = the fixed {dx, dy, scale} per scene entry (keys replace them where both exist). keyed = true when keys moved it during the export. seen = false: an element with keys that never shows in this export (no times or boxes, keys only).',
    ],
    sceneFile: scene?.file || null, sceneLayers: scene?.layers || [], kit: kit || 0,
    note: !scene ? 'This project has no scene HTML, so there are no graphics elements.' : !elements.length ? 'The scene doesn\'t report elements (it doesn\'t draw through the scene kit\'s Octopus.el or data-studio), so only the layer files carry its graphics.'
      : kit < 2 ? 'The project\'s scene kit is version 1: no keyframes or measured boxes (painted). Video Octopus\'s "Update the scene kit" adds them.' : null,
    scenes, elements,
  };
}

// ---- the scene pass: sample element boxes, then render each graphics output in parallel browsers ----
async function scenePass(job, plan, scene, sceneT, { render, separate, onProgress, onOutputs }) {
  const W = plan.parts[0].scene.W, H = plan.parts[0].scene.H, N = plan.frames;
  const live = sceneT.some(Number.isFinite);
  const nw = Math.max(1, Math.min(render ? 4 : 2, Math.ceil(N / 300)));
  const workers = [];
  job.closers.add(() => workers.forEach((w) => w.close()));
  const first = await openScene({ file: join(job.dir, scene.file), W, H, root: job.dir });
  workers.push(first);
  const layers = first.info.layers?.length ? first.info.layers : scene.layers;
  for (let i = 1; i < nw; i++) workers.push(await openScene({ file: join(job.dir, scene.file), W, H, root: job.dir }));
  if (job.cancelled) throw new Error('stopped');
  // Work goes to whichever browser is free.
  const runAll = async (tasks, fn) => {
    let i = 0;
    await Promise.all(workers.map(async (w) => { while (i < tasks.length) { if (job.cancelled) throw new Error('stopped'); await fn(w, tasks[i++]); } }));
  };
  const chunk = Math.ceil(N / workers.length);
  // 1. Sample: the kit's element boxes at every frame of every layer.
  const samples = new Map(layers.map((L) => [L, new Array(N).fill(null)]));
  let sampled = 0;
  const sTasks = live ? layers.flatMap((L) => Array.from({ length: workers.length }, (_, j) => ({ L, a: j * chunk, b: Math.min(N, (j + 1) * chunk) }))) : [];
  await runAll(sTasks, async (w, { L, a, b }) => {
    for (let k = a; k < b; k++) {
      if (Number.isFinite(sceneT[k])) samples.get(L)[k] = (await w.frame(sceneT[k], L, { hits: true, shot: false })).hits;
      if (++sampled % 60 === 0) onProgress('sample', sampled / (N * layers.length));
    }
  });
  onProgress('sample', 1);
  const kit = first.info.kit || 0;
  if (!render) { workers.forEach((w) => w.close()); return { layers, samples, outputs: [], kit }; }
  // 2. What to render: each layer whole, or (separate) per layer the drawing outside every element plus each element.
  const outputs = [];
  for (const L of layers) {
    const lname = L == null ? 'graphics' : L;
    if (!separate) { outputs.push({ key: `g:${L}`, layer: L, only: null, title: L == null ? 'Graphics' : `Graphics · ${L}`, slug: L == null ? 'graphics' : `graphics-${slug(L)}`, window: null }); continue; }
    outputs.push({ key: `g:${L}:rest`, layer: L, only: '', title: `${lname} · everything else`, slug: `${slug(lname)}-rest`, window: null, rest: true });
    const seen = new Map();
    samples.get(L).forEach((hits, k) => { for (const h of hits || []) { const s = seen.get(h[0]); if (!s) seen.set(h[0], { label: h[1], a: k, b: k }); else s.b = k; } });
    for (const [eid, s] of seen) outputs.push({ key: `g:${L}:${eid}`, layer: L, only: eid, element: eid, title: `${lname} · ${s.label}`, slug: `${slug(lname)}-${slug(eid)}`, window: [Math.max(0, s.a - 1), Math.min(N - 1, s.b + 1)] });
  }
  for (const o of outputs) o.chunks = [];
  const blank = blankPng(W, H);
  const tasks = [];
  for (const o of outputs) {
    o.frames = N; o.done = 0;
    const span = o.window ? [o.window[0], o.window[1] + 1] : [0, N];
    // Long outputs are split over the browsers; an element's window stays in one piece.
    const parts = o.window ? [[0, N]] : Array.from({ length: workers.length }, (_, j) => [j * chunk, Math.min(N, (j + 1) * chunk)]).filter(([a, b]) => b > a);
    parts.forEach(([a, b], j) => { const out = `${job.rel}/${o.key.replace(/[^\w.-]+/g, '_')}_${j}.mov`; o.chunks.push(out); tasks.push({ o, a, b, out, span }); });
  }
  onOutputs?.(outputs);
  await runAll(tasks, async (w, { o, a, b, out, span }) => {
    await runFF(job, ['-y', '-v', 'error', '-f', 'image2pipe', '-framerate', String(FPS), '-c:v', 'png', '-i', 'pipe:0', '-frames:v', String(b - a),
      '-vf', ENC.alpha.tail, ...ENC.alpha.args, '-f', 'mov', out], {
      cwd: job.dir,
      input: (proc) => {
        proc.stdin.on('error', () => {});
        (async () => {
          for (let k = a; k < b; k++) {
            if (job.cancelled) break;
            let png = blank;
            if (Number.isFinite(sceneT[k]) && k >= span[0] && k < span[1]) png = (await w.frame(sceneT[k], o.layer, { only: o.only })).png || blank;
            if (!proc.stdin.write(png)) await new Promise((r) => proc.stdin.once('drain', r));
            o.done++;
            if (o.done % 15 === 0) onProgress(o.key, o.done / o.frames);
          }
          proc.stdin.end();
        })().catch((e) => { job.error = job.error || e; try { proc.kill('SIGTERM'); } catch {} });
      },
    }).catch((e) => { throw job.error || e; });
    onProgress(o.key, o.done / o.frames);
  });
  workers.forEach((w) => w.close());
  return { layers, samples, outputs, kit };
}

// ---- Layers export ----
export function startLayersExport(id, dir, body, emit) {
  if (jobs.has(id) || exportInfo(id, dir).running) throw new Error('An export is already running for this project.');
  const opt = { graphics: body.graphics !== false, separate: Boolean(body.separate), matte: body.matte !== false, small: Boolean(body.small), timeline: body.timeline !== false };
  const plan = planParts(id, dir, body);
  const { parts, vparts, frames: N } = plan; // vparts: the parts cut at shot changes (cards, matte); parts: the sound
  const { W, H } = parts[0].scene;
  const now = new Date();
  const stamp = `${now.getFullYear()}${two(now.getMonth() + 1)}${two(now.getDate())}_${two(now.getHours())}${two(now.getMinutes())}${two(now.getSeconds())}`;
  const rel = `work/export/${stamp}_layers`;
  const folder = nextFolder(dir, id, 'layers');
  const name = basename(folder);
  const tmp = join(dir, 'renders', `.${name}.part`);
  // The canvas PNGs, per video part: the background alone, and each card's mask, shadow (under) and border (over).
  mkdirSync(join(dir, rel), { recursive: true });
  for (const p of vparts) {
    if (!p.pngs) throw new Error(`The canvas didn't send the picture layers for "${p.name}". Reload the page and try again.`);
    p.has = new Set();
    const put = (key, buf) => { writeFileSync(join(dir, rel, `${p.tag}_${key}.png`), buf); p.has.add(key); };
    if (p.pngs.bgOnly) put('bg', pngFrom(p.pngs.bgOnly, W, H, `${p.name} background`));
    p.scene.layers.forEach((ly, i) => {
      put(`mask${i}`, pngFrom(p.pngs[`mask${i}`], ly.box.w, ly.box.h, `${p.name} ${ly.role} mask`));
      if (p.pngs[`under${i}`]) put(`under${i}`, pngFrom(p.pngs[`under${i}`], W, H, `${p.name} ${ly.role} shadow`));
      if (p.pngs[`over${i}`]) put(`over${i}`, pngFrom(p.pngs[`over${i}`], W, H, `${p.name} ${ly.role} border`));
    });
    if (!p.pngs.bgOnly && !p.pngs.bgAnimated) throw new Error('The canvas is from an older Video Octopus page. Reload the page and try again.');
  }
  rmSync(tmp, { recursive: true, force: true });
  mkdirSync(tmp, { recursive: true });

  const job = { id, dir, rel, procs: new Set(), closers: new Set(), cancelled: false, started: Date.now(), roles: [], last: null, error: null };
  jobs.set(id, job);

  // ---- the roles: one file each ----
  const bgVisible = vparts.some((p) => p.scene.bgVisible);
  const bgPlan = bgVisible ? backgroundPlan(id, dir, plan.layout, { W, H, total: N / FPS, jobRel: rel }) : null;
  const roles = [];
  const role = (r) => { roles.push({ done: 0, frames: N, state: 'waiting', ...r }); return roles.at(-1); };
  if (bgVisible) role({ key: 'bg', kind: 'bg', title: 'Background', slug: 'background', enc: opt.small ? 'h264' : 'hq', what: bgPlan ? `${bgPlan.label}, drawn frame by frame` : plan.layout.bg.name || 'still background' });
  // Cards in the order the canvas stacks them (screen, camera, then extra takes), across all parts (and shots: a card
  // a shot hides is transparent there).
  const cardKeys = [];
  for (const p of vparts) p.scene.layers.forEach((ly) => { if (!cardKeys.includes(ly.ref)) cardKeys.push(ly.ref); });
  const full = (ly) => ly.box.x <= 0 && ly.box.y <= 0 && ly.box.w >= W && ly.box.h >= H && !ly.radius;
  for (const key of cardKeys) {
    const inParts = vparts.map((p) => p.scene.layers.findIndex((ly) => ly.ref === key));
    const opaque = inParts.every((i, k) => i >= 0 && full(vparts[k].scene.layers[i]) && !vparts[k].has.has(`under${i}`) && !vparts[k].has.has(`over${i}`));
    const ly = vparts[inParts.findIndex((i) => i >= 0)].scene.layers[inParts.find((i) => i >= 0)];
    const title = ly.role === 'screen' ? 'Screen' : ly.role === 'cam' ? 'Camera' : `Layer · ${ly.file}`;
    role({ key, kind: 'card', title, slug: ly.role === 'screen' ? 'screen' : ly.role === 'cam' ? 'camera' : `layer-${slug(basename(ly.file, extname(ly.file)))}`,
      enc: opaque ? (opt.small ? 'h264' : 'hq') : 'alpha', inParts, takeDerived: true,
      what: `${ly.role === 'screen' ? 'the screen recording' : 'the camera'}${ly.card ? ' as a card (shadow, picture, border)' : ''}${opaque ? ', fills the frame' : ', transparent around it'}` });
  }
  // The presenter cut-out, where the canvas camera has a matching matte.
  const masks = opt.matte && plan.info.sources.cam ? findMasks(dir, plan.info.sources.cam) : null;
  let matte = null;
  if (masks) {
    const inParts = vparts.map((p) => (p.kind === 'take' && p.src.cam === plan.take.cam ? p.scene.layers.findIndex((ly) => ly.role === 'cam') : -1));
    if (inParts.some((i) => i >= 0)) matte = { key: 'matte', kind: 'matte', title: 'Presenter cut-out', slug: 'presenter', enc: 'alpha', inParts, takeDerived: true, what: `the presenter cut out of the camera with the matte in ${masks.dir}/ (${masks.count} frames)` };
  }
  const scene = opt.graphics || opt.timeline ? sceneFile(dir) : null;
  const sceneT = sceneTimes(plan);

  // ---- progress ----
  const voiceOn = parts.some((p) => p.sounds.length);
  const stereo = parts.length > 1;
  const audioRoles = [];
  const label0 = `Exporting layers ${name} (${(N / FPS).toFixed(1)} s)`;
  let lastEmit = 0, phase = '';
  const allRoles = () => [...job.roles, ...audioRoles];
  const push = (force) => {
    if (!force && Date.now() - lastEmit < 250) return;
    lastEmit = Date.now();
    const list = allRoles();
    const total = list.reduce((t, r) => t + r.frames, 0) || 1;
    const progress = Math.min(0.99, list.reduce((t, r) => t + Math.min(r.frames, r.done), 0) / total);
    job.last = { t: 'job', id: 'export', kind: 'layers', label: phase ? `${label0} · ${phase}` : label0, progress, cancel: true,
      layers: list.map((r) => ({ name: r.title, file: r.file || null, progress: r.state === 'drawing' ? r.drawn || 0 : r.frames ? Math.min(1, r.done / r.frames) : 0, state: r.state })) };
    emit(job.last);
  };

  // ---- the work ----
  const ff = limiter(3);
  const commands = [];
  // Pieces of one role can run at the same time: the role's progress is what's finished plus what's running.
  const run = (r, args, frames, audio = false) => {
    commands.push({ role: r.title, ffmpeg: [studioTool('ffmpeg'), ...args] });
    return ff(() => {
      r.state = 'rendering';
      const piece = { n: 0 };
      (r.live ||= new Set()).add(piece);
      const upd = () => { r.done = (r.finished || 0) + [...r.live].reduce((t, x) => t + x.n, 0); push(); };
      return runFF(job, args, { cwd: dir, onFrame: audio ? null : (n) => { piece.n = Math.min(frames, n); upd(); }, onTime: audio ? (t) => { piece.n = Math.min(frames, t * FPS); upd(); } : null })
        .then(() => { r.live.delete(piece); r.finished = (r.finished || 0) + frames; upd(); });
    });
  };
  const runAudio = (r, args, frames) => run(r, args, frames, true);
  const concat = (pieces, out, r) => {
    if (pieces.length === 1 && !(r?.reencode)) { renameSync(join(dir, pieces[0]), out); return Promise.resolve(); }
    const list = join(dir, rel, `${slug(r?.slug || basename(out))}_parts.txt`);
    writeFileSync(list, pieces.map((p) => `file '${join(dir, p).replace(/'/g, `'\\''`)}'`).join('\n') + '\n');
    const enc = r?.reencode ? [...ENC.h264.args] : ['-c', 'copy'];
    return runFF(job, ['-y', '-v', 'error', '-f', 'concat', '-safe', '0', '-i', list, ...enc, out], { cwd: dir });
  };

  const work = async () => {
    // Video roles (background, cards, matte) go to ffmpeg; the scene runs in headless browsers at the same time.
    const videoDone = [];
    job.roles = roles;
    for (const r of roles) {
      if (r.kind === 'bg') {
        const out = `${rel}/bg_all.mov`;
        r.pieces = [out];
        videoDone.push((async () => {
          let args;
          if (bgPlan) {
            if (bgPlan.prepare) {
              r.state = 'drawing';
              const render = bgPlan.prepare((p) => { r.drawn = p; phase = `drawing the ${bgPlan.label} background ${Math.round(p * 100)}%`; push(); });
              job.closers.add(() => render.cancel());
              await render.done;
              phase = '';
            }
            // fps: a drawn background comes from bg.mkv with millisecond timestamps; every layer gets exact 1/30 s frames.
            args = [...HEAD, ...bgPlan.input, '-filter_complex', `[0:v]${bgPlan.filter},fps=${FPS},${ENC[r.enc].tail}[out]`, '-map', '[out]', ...ENC[r.enc].args, '-frames:v', String(N), '-f', 'mov', out];
          } else {
            args = [...HEAD, '-loop', '1', '-framerate', String(FPS), '-t', secs(N), '-i', `${rel}/${vparts[0].tag}_bg.png`,
              '-filter_complex', `[0:v]${ENC[r.enc].tail}[out]`, '-map', '[out]', ...ENC[r.enc].args, '-frames:v', String(N), '-f', 'mov', out];
          }
          await run(r, args, N);
        })());
        continue;
      }
      // Cards and the matte: one piece per video part (a part or shot without that card gets transparent frames).
      const multi = vparts.length > 1;
      const pieceEnc = r.enc === 'h264' && multi ? 'hq' : r.enc;
      r.reencode = r.enc === 'h264' && multi;
      r.pieces = vparts.map((p) => `${rel}/${r.slug}_${p.tag}.mov`);
      vparts.forEach((p, k) => {
        const i = r.inParts[k];
        const args = i < 0 ? blankArgs(W, H, p.frames, pieceEnc, r.pieces[k]) : r.kind === 'matte' ? matteArgs(job, p, i, masks, r.pieces[k]) : cardArgs(job, p, i, r.pieces[k], pieceEnc);
        videoDone.push(run(r, args, p.frames));
      });
    }
    if (matte) { roles.push({ done: 0, frames: N, state: 'waiting', ...matte }); const r = roles.at(-1); r.pieces = vparts.map((p) => `${rel}/presenter_${p.tag}.mov`);
      vparts.forEach((p, k) => { const i = r.inParts[k]; videoDone.push(run(r, i < 0 ? blankArgs(W, H, p.frames, 'alpha', r.pieces[k]) : matteArgs(job, p, i, masks, r.pieces[k]), p.frames)); }); }
    // Sound: the voice (cut like the picture) and the sound cues on their own.
    const audioDone = [];
    if (voiceOn) audioRoles.push({ key: 'voice', kind: 'audio', title: 'Voice', slug: 'voice', file: 'voice.wav', done: 0, frames: N, state: 'waiting' });
    const cueParts = parts.map((p) => soundArgs(dir, p, 'cues', `${rel}/cues_${p.tag}.wav`, { stereo: true }));
    if (cueParts.some((c) => c.cues)) audioRoles.push({ key: 'cues', kind: 'audio', title: 'Sound cues', slug: 'sound-cues', file: 'sound-cues.wav', done: 0, frames: N, state: 'waiting', cues: cueParts.reduce((t, c) => t + c.cues, 0) });
    for (const r of audioRoles) {
      r.pieces = parts.map((p) => `${rel}/${r.key}_${p.tag}.wav`);
      parts.forEach((p, k) => audioDone.push(runAudio(r, r.key === 'cues' ? cueParts[k].args : soundArgs(dir, p, 'voice', r.pieces[k], { stereo }).args, p.frames)));
    }
    // Every ffmpeg task is under way; the first failure stops the rest (and the scene's browsers).
    const allDone = Promise.all([...videoDone, ...audioDone]);
    allDone.catch((e) => { if (!job.cancelled) { job.error = job.error || e; stopJob(job); } });
    // The scene: element boxes for the motion data, and the graphics layers.
    let sc = null;
    const gfx = [];
    if (scene) {
      const sr = { key: 'scene', kind: 'scene', title: opt.graphics ? 'Graphics' : 'Motion data', done: 0, frames: N, state: 'sampling' };
      job.roles = [...roles, sr];
      const byKey = new Map();
      sc = await scenePass(job, plan, scene, sceneT, {
        render: opt.graphics, separate: opt.separate,
        onOutputs: (outputs) => {
          for (const o of outputs) { const g = { key: o.key, kind: 'gfx', title: o.title, slug: o.slug, enc: 'alpha', done: 0, frames: N, state: 'waiting', pieces: o.chunks, out: o }; gfx.push(g); byKey.set(o.key, g); }
          job.roles = [...roles, ...gfx];
        },
        onProgress: (key, p) => {
          if (key === 'sample') { sr.state = 'sampling'; sr.done = Math.round(p * N * (opt.graphics ? 0.1 : 1)); }
          else { const g = byKey.get(key); if (g) { g.done = Math.round(p * N); g.state = 'rendering'; } }
          push();
        },
      }).catch((e) => { throw e.message === 'stopped' ? e : new Error(`The scene's graphics: ${e.message}`); });
      for (const g of gfx) { g.done = N; g.state = 'done'; }
      job.roles = [...roles, ...gfx];
    }
    await allDone;
    for (const r of [...roles, ...audioRoles]) r.state = 'done';
    push(true);
    // ---- the stack, bottom to top: background, cards, graphics (the first of several layers goes behind the presenter), presenter, the rest ----
    const cards = roles.filter((r) => r.kind === 'card');
    const bg = roles.find((r) => r.kind === 'bg');
    const mt = roles.find((r) => r.kind === 'matte');
    const byLayer = (L) => gfx.filter((g) => g.out.layer === L);
    const gLayers = sc ? sc.layers : [];
    const stack = [...(bg ? [bg] : []), ...cards];
    if (gLayers.length >= 2) { stack.push(...byLayer(gLayers[0])); if (mt) stack.push(mt); for (const L of gLayers.slice(1)) stack.push(...byLayer(L)); }
    else { if (mt) stack.push(mt); for (const L of gLayers) stack.push(...byLayer(L)); }
    stack.forEach((r, i) => { r.file = `${two(i + 1)}_${r.slug}.mov`; });
    phase = 'joining the parts';
    push(true);
    await Promise.all(stack.map((r) => concat(r.pieces, join(tmp, r.file), r)));
    await Promise.all(audioRoles.map((r) => concat(r.pieces, join(tmp, r.file), r)));
    // ---- motion data, timeline files, README ----
    phase = 'writing the timeline files';
    push(true);
    const elFiles = Object.fromEntries(gfx.filter((g) => g.out.element).map((g) => [g.out.element, g.file]));
    const motion = sc ? motionData(plan, scene, sc.samples, sceneT, id, dir, elFiles, sc.kit) : null;
    if (motion) writeFileSync(join(tmp, 'motion.json'), JSON.stringify(motion, null, 1));
    const media = new Map();
    for (const r of [...stack, ...audioRoles]) media.set(join(dir, folder, r.file), mediaInfo(join(tmp, r.file)));
    const timeline = opt.timeline ? layersTimeline({ plan, stack, audioRoles, media, folder: join(dir, folder), name: `${projectMeta(dir)?.name || id} · layers` }) : null;
    let checked = null;
    if (timeline) {
      writeFileSync(join(tmp, `${name}.fcpxml`), fcpxml(timeline));
      writeFileSync(join(tmp, `${name}.xml`), xmeml(timeline));
      checked = await wellFormed([join(tmp, `${name}.fcpxml`), join(tmp, `${name}.xml`)]);
    }
    const manifest = {
      v: 1, by: 'Video Octopus layers export', project: id, made: new Date().toISOString(), frame: [W, H], rate: `${FPS}/1`, fps: FPS, frames: N, duration: Math.round((N / FPS) * 1000) / 1000,
      cut: plan.useCut && plan.cut ? plan.cut.file : null, parts: parts.map((p) => ({ name: p.name, kind: p.kind, start: p.start, frames: p.frames, segments: p.segs })),
      ...(vparts !== parts ? { shots: vparts.filter((p) => p.shots).map((p) => ({ name: p.name, shots: p.shots, start: p.start, frames: p.frames, preset: p.scene.preset, cards: p.scene.layers.map((ly) => ly.ref) })),
        transitions: plan.transitions } : {}),
      video: stack.map((r, i) => ({ order: i + 1, file: r.file, layer: r.title, codec: ENC[r.enc].label, alpha: r.enc === 'alpha', what: r.what || null })),
      audio: audioRoles.map((r) => ({ file: r.file, what: r.title, cues: r.cues || null })),
      timeline: timeline ? { fcpxml: `${name}.fcpxml`, xmeml: `${name}.xml`, wellFormed: checked } : null, motion: motion ? 'motion.json' : null,
    };
    writeJSON(join(tmp, 'layers.json'), manifest);
    writeFileSync(join(tmp, 'README.txt'), readme({ name, id, dir, plan, manifest, stack, audioRoles, scene, motion, masks, opt, checked }));
    writeJSON(join(dir, rel, 'job.json'), { out: folder, options: opt, layout: plan.layout, manifest, commands });
    rmSync(join(dir, folder), { recursive: true, force: true });
    renameSync(tmp, join(dir, folder));
    return { stack, manifest, motion };
  };

  push(true);
  work().then(({ stack, manifest, motion }) => {
    jobs.delete(id);
    const took = ((Date.now() - job.started) / 1000).toFixed(0);
    appendWorklog(dir, `Exported layers ${folder}/ (${stack.length} video layer${stack.length > 1 ? 's' : ''}: ${stack.map((r) => r.slug).join(', ')}` +
      `${audioRoles.length ? `; ${audioRoles.map((r) => r.file).join(' + ')}` : ''}; ${(N / FPS).toFixed(1)} s at ${FPS} fps` +
      `${plan.useCut && plan.cut ? `, cut from ${plan.cut.file}` : ', whole take'}${parts.length > 1 ? `, ${parts.length} block parts` : ''}${vparts !== parts ? `, shot by shot (${vparts.length} pieces${plan.transitions.length ? `, ${plan.transitions.length} crossfade${plan.transitions.length > 1 ? 's' : ''} as cuts` : ''})` : ''}` +
      `${manifest.timeline ? '; FCPXML + FCP 7 XML (import untested)' : ''}${motion ? `; motion data, ${motion.elements.length} elements` : ''}; job ${rel}, ${took} s)`);
    logTrialUse(dir, relative(settings().studio, dir), { bg: plan.layout.bg, preset: parts[0].scene.preset, out: folder });
    rmChunks(dir, rel);
    emit({ t: 'job', id: 'export', kind: 'layers', label: `Exported layers ${name}`, progress: 1, done: true, ok: true, folder,
      layers: manifest.video.map((v) => ({ name: v.layer, file: v.file, progress: 1, state: 'done' })), seconds: Number(took) });
    emit({ t: 'files' });
  }, (e) => {
    jobs.delete(id);
    stopJob(job);
    rmSync(tmp, { recursive: true, force: true });
    rmChunks(dir, rel);
    const why = job.userStopped ? 'Layers export stopped' : `Layers export failed: ${(job.error || e).message}`;
    emit({ t: 'job', id: 'export', kind: 'layers', label: why, progress: 1, done: true, ok: Boolean(job.userStopped) });
    emit({ t: 'files' });
  });
  return { out: folder, frames: N, duration: N / FPS, job: rel, parts: parts.length };
}

// The rendered pieces go once the export is done or stopped; the PNGs, job.json and the background render stay.
function rmChunks(dir, rel) {
  try { for (const f of readdirSync(join(dir, rel))) if (/\.(mov|wav)$|_parts\.txt$/.test(f) && f !== 'bg.mkv') rmSync(join(dir, rel, f), { force: true }); } catch {}
}

function stopJob(job) {
  job.cancelled = true;
  for (const p of job.procs) { try { p.kill('SIGTERM'); } catch {} }
  for (const c of job.closers) { try { c(); } catch {} }
}
export function cancelLayers(id) {
  const job = jobs.get(id);
  if (!job) return false;
  job.userStopped = true;
  stopJob(job);
  return true;
}
export const stopAllLayers = () => { for (const j of jobs.values()) stopJob(j); };

function wellFormed(files) {
  return new Promise((res) => execFile('/usr/bin/xmllint', ['--noout', ...files], (err) => res(err ? (err.code === 'ENOENT' ? null : false) : true)));
}

// The timeline of a layers export: one track per file, in stack order. Tracks that come from the take (cards,
// presenter, voice) are cut at every join of the locked cut and every block, so the edit points show; the
// background, graphics and sound cues are one clip each.
function layersTimeline({ plan, stack, audioRoles, media, folder, name }) {
  const N = plan.frames;
  // Clips: every join of the cut, every block and (picture tracks) every shot change is an edit point.
  const piecesOf = (list) => {
    const out = [];
    for (const p of list) {
      if (p.kind === 'take' && p.segs) { let k = p.start; for (const [a, b] of p.segs) { const n = Math.round((b - a) * FPS); out.push({ part: p, at: k, dur: n }); k += n; } }
      else out.push({ part: p, at: p.start, dur: p.frames });
    }
    return out;
  };
  const vpieces = piecesOf(plan.vparts), apieces = piecesOf(plan.parts);
  const clipsOf = (r, file) => {
    if (!r.takeDerived && r.kind !== 'audio') return [{ file, name: r.title, at: 0, dur: N, in: 0, alpha: r.enc === 'alpha' }];
    const list = r.kind === 'audio' ? apieces.filter(({ part }) => r.key === 'cues' || part.sounds.length) : vpieces.filter(({ part }) => r.inParts[plan.vparts.indexOf(part)] >= 0);
    return list.map(({ part, at, dur }) => ({ file, name: `${r.title} · ${part.name}`, at, dur, in: at / FPS, alpha: r.enc === 'alpha' }));
  };
  const video = stack.map((r) => ({ name: r.title, clips: clipsOf(r, join(folder, r.file)) }));
  const audio = audioRoles.map((r) => ({ name: r.title, role: r.key === 'voice' ? 'dialogue' : 'effects',
    clips: r.key === 'cues' ? [{ file: join(folder, r.file), name: r.title, at: 0, dur: N, in: 0 }] : clipsOf(r, join(folder, r.file)) }));
  return { name, event: name, rate: { num: FPS, den: 1 }, W: plan.parts[0].scene.W, H: plan.parts[0].scene.H, frames: N, media, video, audio };
}

function readme({ name, id, dir, plan, manifest, stack, audioRoles, scene, motion, masks, opt, checked }) {
  const N = plan.frames, meta = projectMeta(dir);
  const L = [];
  L.push(`${meta?.name || id} · layers export (${name})`, `Made by Video Octopus on ${new Date().toLocaleString('en-GB')}.`, '');
  L.push(`Every file below is ${manifest.frame[0]}×${manifest.frame[1]} (sound: 48 kHz), ${FPS} fps (${FPS}/1, not 29.97), ${(N / FPS).toFixed(3)} s = ${N} frames long, and starts at 0:00.`,
    'Put them all at 0:00 on one timeline, in this order, and you get the Video Octopus MP4 export back (plus the graphics and the presenter cut-out, which the MP4 export does not include).', '');
  L.push(`The timeline: ${plan.useCut && plan.cut ? `the locked cut (${plan.cut.file})` : 'the whole take'}${plan.parts.length > 1 ? `, with the blocks in this order: ${plan.parts.map((p) => `${p.name} at ${clock(p.start / FPS)}`).join(' · ')}` : ''}.`, '');
  L.push('VIDEO, bottom to top');
  for (const v of manifest.video) L.push(`  ${String(v.order).padStart(2)}. ${v.file}  ·  ${v.codec}  ·  ${v.layer}${v.what ? `: ${v.what}` : ''}`);
  L.push('');
  if (audioRoles.length) {
    L.push('SOUND (WAV, 48 kHz, 24-bit)');
    for (const a of audioRoles) L.push(`  ${a.file}  ·  ${a.key === 'voice' ? `the voice (${plan.parts.some((p) => p.sounds.some((s) => /_webcam\./i.test(s))) ? 'camera mic' : 'the take\'s sound'}), cut like the picture` : `${a.cues} sound cue${a.cues > 1 ? 's' : ''} from the Sound panel, at the level the export mixes them (about ${underVoiceDb()} dB under the voice, Settings → Sound)`}`);
    L.push(audioRoles.length > 1 ? '  Play both at full level (0 dB) to get the export\'s mix.' : '  Play it at full level (0 dB).', '');
  }
  if (plan.vparts !== plan.parts) {
    L.push('SHOTS');
    L.push(`  The take renders shot by shot (work/shots.json; proposed shots left out): each card follows its shot's look (box, crop, zoom, border), and a card a shot hides is transparent there.`);
    for (const p of plan.vparts.filter((x) => x.shots)) L.push(`  ${clock(p.start / FPS)}  ${p.name}: ${PRESETS[p.scene.preset] || p.scene.preset}${p.scene.layers.length ? ` (${p.scene.layers.map((ly) => (ly.role === 'cam' ? 'camera' : ly.role === 'screen' ? 'screen' : ly.file)).join(', ')})` : ' (background only)'}`);
    if (plan.transitions.length) L.push(`  Shot changes are cuts in these files. The MP4 export crossfades ${plan.transitions.length === 1 ? 'one of them' : `${plan.transitions.length} of them`}; to match it, add a crossfade in your editor: ${plan.transitions.map((t) => `${clock(t.at)} (${t.dur} s, centred on the change)`).join(', ')}. layers.json lists them under "transitions".`);
    L.push('');
  }
  L.push('NOTES');
  L.push('  Alpha is straight (not premultiplied). Colour: Rec. 709, video range.');
  L.push('  Cards (screen, camera) carry their own shadow and border; the background has none.');
  if (masks) L.push(`  The presenter cut-out uses the matte in ${masks.dir}/ and sits exactly over the camera, so graphics can go between the two.`);
  if (scene) {
    L.push(`  Graphics come from ${scene.file} (seek(t) drawn in a headless browser, frame by frame), on the scene's own timeline${plan.parts.some((p) => p.kind === 'file') ? '; blocks with their own file have none' : ''}.`);
    if (opt.separate) L.push('  "Separate every graphic" was on: each Octopus.el element is its own file, plus one file per scene layer with everything drawn outside the elements ("everything else", stacked first). Where the scene draws other things between elements, the stack order can differ slightly from the scene.');
    if (masks && stack.some((r) => r.kind === 'gfx') && scene.layers.length > 1) L.push(`  With several scene layers, the first (${scene.layers[0] ?? 'graphics'}) goes behind the presenter cut-out, as the house compositor does.`);
  }
  if (motion) L.push(`  motion.json: ${motion.elements.length} graphic element${motion.elements.length === 1 ? '' : 's'} with their in/out times, boxes over time and any keyframes ("keys") from work/overrides.json.`);
  L.push('');
  if (manifest.timeline) {
    L.push('TIMELINE FILES (import is untested: no editor was installed on the Mac that made them)');
    L.push(`  ${manifest.timeline.fcpxml}  ·  Final Cut Pro, DaVinci Resolve (FCPXML 1.10)`);
    L.push(`  ${manifest.timeline.xmeml}  ·  Premiere Pro, DaVinci Resolve (Final Cut Pro 7 XML, xmeml version 5)`);
    L.push(`  Tracks: ${stack.map((r, i) => `V${i + 1} ${r.title}`).join(', ')}${audioRoles.length ? `, ${audioRoles.map((r, i) => `A${i + 1} ${r.title}`).join(', ')}` : ''}. Take tracks are cut at every join, so the edit points show.`);
    L.push(`  They point at these files by absolute path; if you move the folder, relink. ${checked === true ? 'Checked: both are well-formed XML (xmllint).' : checked === false ? 'xmllint found a problem in one of them.' : ''}`.trimEnd(), '');
  }
  L.push('layers.json lists the same in a form other tools can read.', '');
  return L.join('\n');
}

// ---- Timeline file straight from the sources (no rendering) ----
export function startTimelineExport(id, dir, body, emit) {
  if (jobs.has(id) || exportInfo(id, dir).running) throw new Error('An export is already running for this project.');
  const plan = planParts(id, dir, { ...body, pngs: null });
  const folder = nextFolder(dir, id, 'timeline');
  const name = basename(folder);
  const tmp = join(dir, 'renders', `.${name}.part`);
  const abs = (p) => (p ? join(dir, p) : null);
  const W = plan.parts[0].scene.W, H = plan.parts[0].scene.H;
  // A take part's shot changes (plan.vparts) are edit points too: its clips are cut there and named after their shot.
  const shotsOf = (p) => plan.vparts.filter((v) => v.parent === p.tag);
  const parts = plan.parts.map((p) => (p.kind === 'take'
    ? { kind: 'take', name: p.name, segs: p.segs, screen: abs(p.src.screen), cam: abs(p.src.cam), layers: plan.layout.layers.map((x) => abs(`source/${x.file}`)), sound: abs(p.sounds[0]),
      layerSound: p.sounds.slice(1).map(abs), range: p.range,
      ...(shotsOf(p).length ? { breaks: shotsOf(p).slice(1).map((v) => v.segs[0][0]), shotName: (t) => shotsOf(p).findLast((v) => v.segs[0][0] <= t + 1e-6)?.shotLabel || null } : {}) }
    : { kind: 'file', name: p.name, screen: abs(p.src.screen), cam: abs(p.src.cam), sound: abs(p.sounds[0]), duration: p.total }));
  const job = { id, dir, procs: new Set(), closers: new Set(), cancelled: false, started: Date.now(), last: null, error: null };
  jobs.set(id, job);
  const label = `Writing the timeline file ${name}`;
  emit(job.last = { t: 'job', id: 'export', kind: 'timeline', label, progress: 0.05, cancel: true });
  const work = async () => {
    rmSync(tmp, { recursive: true, force: true });
    mkdirSync(tmp, { recursive: true });
    const spec = sourcesSpec({ name: `${projectMeta(dir)?.name || id} · from the sources`, W, H, parts, dir, voiceFile: abs(plan.parts[0].sounds[0]) });
    spec.event = spec.name;
    writeFileSync(join(tmp, `${name}.fcpxml`), fcpxml(spec));
    writeFileSync(join(tmp, `${name}.xml`), xmeml(spec));
    const checked = await wellFormed([join(tmp, `${name}.fcpxml`), join(tmp, `${name}.xml`)]);
    // Motion data: the scene's elements, sampled on the export timeline (quick: no pictures).
    const scene = sceneFile(dir);
    let motion = null;
    if (scene) {
      const sceneT = sceneTimes(plan);
      const sc = await scenePass(job, plan, scene, sceneT, { render: false, onProgress: (k, p) => { emit(job.last = { ...job.last, label: `${label} · reading the scene's graphics ${Math.round(p * 100)}%`, progress: 0.1 + p * 0.85 }); } })
        .catch((e) => { if (e.message === 'stopped') throw e; job.sceneError = e.message; return null; });
      if (sc) { motion = motionData(plan, scene, sc.samples, sceneT, id, dir, null, sc.kit); writeFileSync(join(tmp, 'motion.json'), JSON.stringify(motion, null, 1)); }
    }
    const fpsTxt = spec.rate.den === 1001 ? `${(spec.rate.num / 1001).toFixed(2)} fps (${spec.rate.num}/${spec.rate.den})` : `${spec.rate.num / spec.rate.den} fps (${spec.rate.num}/${spec.rate.den})`;
    const manifest = { v: 1, by: 'Video Octopus timeline file', project: id, made: new Date().toISOString(), frame: [W, H], rate: `${spec.rate.num}/${spec.rate.den}`, frames: spec.frames,
      duration: Math.round((spec.frames * spec.rate.den / spec.rate.num) * 1000) / 1000, video: spec.video.map((t, i) => ({ order: i + 1, layer: t.name, clips: t.clips.length })),
      audio: spec.audio.map((t) => ({ what: t.name, clips: t.clips.length })), timeline: { fcpxml: `${name}.fcpxml`, xmeml: `${name}.xml`, wellFormed: checked }, motion: motion ? 'motion.json' : null };
    writeJSON(join(tmp, 'layers.json'), manifest);
    const meta = projectMeta(dir);
    writeFileSync(join(tmp, 'README.txt'), [
      `${meta?.name || id} · timeline file (${name})`, `Made by Video Octopus on ${new Date().toLocaleString('en-GB')}, straight from the sources (nothing rendered).`, '',
      `Sequence: ${W}×${H}, ${fpsTxt}, the camera's own rate; ${manifest.duration.toFixed(3)} s = ${spec.frames} frames. ${plan.useCut && plan.cut ? `The locked cut (${plan.cut.file}) as separate clips, gaps closed` : 'The whole take'}${plan.parts.length > 1 ? `, blocks in order: ${plan.parts.map((p) => p.name).join(' · ')}` : ''}.`, '',
      'FILES (import is untested: no editor was installed on the Mac that made them)',
      `  ${name}.fcpxml  ·  Final Cut Pro, DaVinci Resolve (FCPXML 1.10)`,
      `  ${name}.xml  ·  Premiere Pro, DaVinci Resolve (Final Cut Pro 7 XML, xmeml version 5; a stereo sound takes two tracks)`,
      `  Tracks: ${spec.video.map((t, i) => `V${i + 1} ${t.name}`).join(', ')}${spec.audio.length ? `, ${spec.audio.map((t, i) => `A${i + 1} ${t.name}`).join(', ')}` : ''}.`,
      '  The screen and camera are the original recordings at full frame, without Video Octopus\'s layout (the editor places them). Sound cues are the library files at their times, at the level Video Octopus mixes them.',
      '  For the background, the cards as they sit in the layout, the graphics and the presenter cut-out as files, use Export → Layers.',
      `  Files are referenced by absolute path (the project's source/ and the sound library). ${checked === true ? 'Checked: both are well-formed XML (xmllint).' : checked === false ? 'xmllint found a problem in one of them.' : ''}`.trimEnd(),
      motion ? `  motion.json: ${motion.elements.length} graphic elements from ${scene.file} with their times and boxes (30 fps export timeline).` : job.sceneError ? `  No motion data: ${job.sceneError}` : '',
      '',
    ].join('\n'));
    rmSync(join(dir, folder), { recursive: true, force: true });
    renameSync(tmp, join(dir, folder));
    return { spec, motion };
  };
  work().then(({ spec, motion }) => {
    jobs.delete(id);
    appendWorklog(dir, `Exported timeline file ${folder}/ (FCPXML 1.10 + FCP 7 XML from the sources, import untested; ${spec.video.length} video + ${spec.audio.length} sound tracks, ${spec.rate.num}/${spec.rate.den} fps, ${spec.frames} frames${motion ? `; motion data, ${motion.elements.length} elements` : ''})`);
    emit({ t: 'job', id: 'export', kind: 'timeline', label: `Wrote the timeline file ${name}`, progress: 1, done: true, ok: true, folder });
    emit({ t: 'files' });
  }, (e) => {
    jobs.delete(id);
    stopJob(job);
    rmSync(tmp, { recursive: true, force: true });
    emit({ t: 'job', id: 'export', kind: 'timeline', label: job.userStopped ? 'Timeline file stopped' : `Timeline file failed: ${e.message}`, progress: 1, done: true, ok: Boolean(job.userStopped) });
  });
  return { out: folder };
}

// ---- routes (server/index.mjs calls this before reading JSON bodies) ----
export async function layersRoute(req, res, { id, dir, action, send, body, emit }) {
  if (action === '/export-kinds' && req.method === 'GET') { send(res, 200, layersInfo(id, dir)); return true; }
  if (action === '/export-layers' && req.method === 'POST') {
    const b = await body(req, 120e6);
    try { send(res, 200, startLayersExport(id, dir, b, emit)); } catch (e) { send(res, 400, { error: e.message }); }
    return true;
  }
  if (action === '/export-timeline' && req.method === 'POST') {
    const b = await body(req);
    try { send(res, 200, startTimelineExport(id, dir, b, emit)); } catch (e) { send(res, 400, { error: e.message }); }
    return true;
  }
  return false;
}
