// Simple export: the canvas layout (screen + webcam) rendered with ffmpeg into renders/, on the locked
// cut when there is one, with the webcam's audio. Geometry comes from web/layout.js (the same code the
// canvas draws with); the static parts (a still background, card shadows, borders, rounded masks)
// are PNGs the canvas drew, so the MP4 matches the preview. An animated background (stars, LED wave, code,
// video) is rendered first by server/backgrounds.mjs and goes under everything. Every export is a self-contained job folder
// in work/export/<stamp>/ (PNGs + job.json + run.sh), so it can be re-run without the app.
import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { existsSync, mkdirSync, readdirSync, renameSync, rmSync, writeFileSync, chmodSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { studioTool, writeJSON, settings, h264, videoDecodeArgs } from './util.mjs';
import { backgroundPlan, logTrialUse } from './backgrounds.mjs';
import { roles, probe, lockedCut, appendWorklog, projectMeta } from './studio.mjs';
import { compose, normalize, snapSegments, FPS } from '../web/layout.js';
import { mixCues, readCues } from './sound.mjs';
import { lockState } from './cutreview.mjs';
import { builtForExport, exportChoice } from './built.mjs';
import { sequenceForExport } from './blocks.mjs';
import { blockLayout } from '../web/blockseq.js';
import { burnCaptions } from './export-words.mjs';
import { shotsPlan, exportShots } from './export-shots.mjs';

const jobs = new Map(); // project id -> running job
export const exportsBusy = () => jobs.size > 0;

// Which files are the screen and the camera on the canvas. A lone file without _screen/_webcam is the camera.
// A mic-only take (<stamp>_audio.wav) has neither: only its sound, under the layout's background.
export function canvasSources(dir) {
  const r = roles(dir);
  if (r.screen || r.webcam) return { screen: r.screen, cam: r.webcam };
  if (r.audioOnly) return { screen: null, cam: null, audio: r.main };
  return { screen: null, cam: r.main };
}

export function exportInfo(id, dir) {
  const src = canvasSources(dir);
  const info = {}, dims = { files: {} }, layerAudio = {};
  for (const k of ['screen', 'cam']) {
    const p = src[k] && probe(dir, src[k]);
    if (p?.w) { info[k] = p; dims[k] = [p.w, p.h]; }
  }
  if (src.audio) { const p = probe(dir, src.audio); if (p?.duration) info.audio = p; } // mic-only take: length and sound
  // Extra layers (other takes) in the saved layout, and which of them have sound.
  for (const x of projectMeta(dir)?.layout?.layers || []) {
    const p = typeof x?.file === 'string' && !/[\\/]/.test(x.file) && existsSync(join(dir, 'source', x.file)) ? probe(dir, x.file) : null;
    if (p?.w) { dims.files[x.file] = [p.w, p.h]; layerAudio[x.file] = p.audio; }
  }
  const lengths = Object.values(info).map((p) => p.duration).filter(Boolean);
  const duration = lengths.length ? Math.min(...lengths) : 0;
  const audio = info.cam?.audio ? 'cam' : info.screen?.audio ? 'screen' : info.audio?.audio ? 'audio' : null;
  const cut = lockedCut(dir);
  let cutInfo = null;
  if (cut && duration) {
    const segs = snapSegments(cut.segments, duration);
    // state: locked (the Lock step holds), changed (edited after the lock, its joins not checked yet), unlocked (Unlock to
    // edit pressed since the lock) or rough (no lock yet).
    const ls = lockState(dir);
    if (segs.length) cutInfo = { file: cut.file, count: segs.length, duration: segs.reduce((t, [a, b]) => t + b - a, 0), segments: segs, state: ls.locked ? (ls.changed ? 'changed' : ls.unlocked ? 'unlocked' : 'locked') : 'rough' };
  }
  const job = jobs.get(id);
  const out = { sources: src, dims, duration, audio, layerAudio, cut: cutInfo, running: job ? { label: job.label, progress: job.progress } : null };
  // Built blocks (the Intro Claude rendered): the Export panel's rows, and what the export puts in (server/built.mjs).
  try { out.built = builtForExport(dir, id, out, { cues: readCues(dir) }); } catch (e) { console.error('built:', e.message); out.built = []; }
  return out;
}

// PNG from the browser as a data URL; checks the size so the layers line up.
function pngFrom(dataUrl, w, h, what) {
  const m = /^data:image\/png;base64,(.+)$/.exec(dataUrl || '');
  if (!m) throw new Error(`Missing the ${what} layer from the canvas.`);
  const buf = Buffer.from(m[1], 'base64');
  if (buf.length < 24 || buf.toString('latin1', 12, 16) !== 'IHDR') throw new Error(`The ${what} layer isn't a PNG.`);
  const pw = buf.readUInt32BE(16), ph = buf.readUInt32BE(20);
  if (pw !== w || ph !== h) throw new Error(`The ${what} layer is ${pw}×${ph}, expected ${w}×${h}. Reload the page and try again.`);
  return buf;
}

const quote = (a) => (/^[\w./:=@%+-]+$/.test(a) ? a : `'${String(a).replace(/'/g, `'\\''`)}'`);

function nextName(dir, id, preset) {
  const base = `${id}_${preset}`;
  let n = 1;
  try {
    for (const f of readdirSync(join(dir, 'renders'))) {
      const m = new RegExp(`^${base.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}_v(\\d+)\\.mp4$`).exec(f);
      if (m) n = Math.max(n, Number(m[1]) + 1);
    }
  } catch {}
  return `renders/${base}_v${n}.mp4`;
}

export function startExport(id, dir, body, emit) {
  if (jobs.has(id)) throw new Error('An export is already running for this project.');
  // Blocks (M3b) that change the video (own files, another order) export part by part: exportSequence.
  const seq = body.blocks === false ? null : sequenceForExport(dir, { useCut: body.useCut !== false });
  const layout = normalize(body.layout, projectMeta(dir)?.type);
  const info = exportInfo(id, dir);
  // Built blocks (server/built.mjs): a block Claude rendered (the Intro) plays its render unless the creator picked the
  // canvas for it (body.built[id] === false); the sound cues of its graphics go with it.
  const built = info.duration ? builtForExport(dir, id, info, { useCut: body.useCut !== false, cues: readCues(dir) }) : [];
  const { use, skipCue } = exportChoice(built, body.built);
  body = { ...body, skipCue };
  // Shots (work/shots.json) that give some stretch of the take its own look, or a built block's render: the export goes
  // shot by shot, each in its look, joined with cuts and crossfades (server/export-shots.mjs). Without them, the exports
  // below run as they always did.
  if (info.duration) {
    const sp = shotsPlan(dir, { layout, info, useCut: body.useCut !== false, seq, effects: body.effects });
    if (sp.changes || use.length) return exportShots(id, dir, body, emit, { jobs, pngFrom, nextName, quote, seq, layout, info, sp, built: use });
  }
  if (seq) return exportSequence(id, dir, body, emit, seq);
  const scene = compose(layout, info.dims);
  // A mic-only take has no video layers: the export is the background (base PNG, or the animated one) with its sound.
  if ((!scene.layers.length && !info.sources.audio) || !info.duration) throw new Error('Nothing to export yet: add a recording first.');
  const { W, H } = scene;
  const pngs = body.pngs || {};

  const now = new Date(), two = (v) => String(v).padStart(2, '0');
  const stamp = `${now.getFullYear()}${two(now.getMonth() + 1)}${two(now.getDate())}_${two(now.getHours())}${two(now.getMinutes())}${two(now.getSeconds())}`;
  const jobRel = `work/export/${stamp}`;
  const files = { base: pngFrom(pngs.base, W, H, 'background') };
  scene.layers.forEach((ly, i) => {
    files[`mask${i}`] = pngFrom(pngs[`mask${i}`], ly.box.w, ly.box.h, `${ly.role} mask`);
    if (pngs[`mid${i}`]) files[`mid${i}`] = pngFrom(pngs[`mid${i}`], W, H, `${ly.role} frame`);
  });
  mkdirSync(join(dir, jobRel), { recursive: true });
  mkdirSync(join(dir, 'renders'), { recursive: true });
  for (const [k, buf] of Object.entries(files)) writeFileSync(join(dir, jobRel, `${k}.png`), buf);

  // The cut, snapped to whole frames. Picture and sound use the same frame-time test, so they stay in sync.
  const cut = body.useCut !== false && info.cut ? lockedCut(dir) : null;
  const segs = cut ? snapSegments(cut.segments, info.duration) : null;
  const total = segs ? segs.reduce((t, [a, b]) => t + b - a, 0) : Math.floor(info.duration * FPS) / FPS;
  const half = 0.5 / FPS;
  const bgPlan = backgroundPlan(id, dir, layout, { W, H, total, jobRel });
  const sel = segs ? segs.map(([a, b]) => `gte(t,${(a - half).toFixed(5)})*lt(t,${(b - half).toFixed(5)})`).join('+') : null;

  // Inputs: the videos, then the still PNG layers, held for the length of the export.
  const args = ['-y', '-v', 'error', '-nostats', '-progress', 'pipe:1'];
  let n = 0;
  const input = (list) => { args.push(...list); return n++; };
  const fileOf = (ly) => (ly.role === 'layer' ? ly.file : info.sources[ly.role]);
  const dimsOf = (ly) => (ly.role === 'layer' ? info.dims.files[ly.file] : info.dims[ly.role]);
  const vid = {};
  for (const ly of scene.layers) vid[fileOf(ly)] ??= input([...videoDecodeArgs(), '-i', `source/${fileOf(ly)}`]);
  const still = (name) => input(['-loop', '1', '-framerate', String(FPS), '-t', total.toFixed(3), '-i', `${jobRel}/${name}.png`]);
  const bgIn = bgPlan ? input(bgPlan.input) : null;
  const baseIn = still('base');
  const maskIn = scene.layers.map((_, i) => still(`mask${i}`));
  const midIn = scene.layers.map((_, i) => (files[`mid${i}`] ? still(`mid${i}`) : null));

  const f = [];
  const pick = sel ? `,select='${sel}',setpts=N/${FPS}/TB` : '';
  scene.layers.forEach((ly, i) => {
    const p = dimsOf(ly);
    const cw = Math.round(ly.crop.w * p[0]), ch = Math.round(ly.crop.h * p[1]);
    // Even offsets: hardware-decoded frames are NV12, and an odd chroma offset would swap U and V (blue skin).
    const cx = 2 * Math.round((ly.crop.x * p[0]) / 2), cy = 2 * Math.round((ly.crop.y * p[1]) / 2);
    f.push(`[${vid[fileOf(ly)]}:v]setpts=PTS-STARTPTS,fps=${FPS}${pick},crop=${cw}:${ch}:${cx}:${cy},` +
      `scale=${ly.box.w}:${ly.box.h}:flags=lanczos${ly.mirror ? ',hflip' : ''},format=rgba[v${i}]`);
    f.push(`[${maskIn[i]}:v]format=gray[k${i}]`, `[v${i}][k${i}]alphamerge=shortest=1[a${i}]`);
  });
  let cur = backgroundChain(f, bgPlan, bgIn, baseIn);
  scene.layers.forEach((ly, i) => {
    f.push(`${cur}[a${i}]overlay=${ly.box.x}:${ly.box.y}:format=rgb${i === 0 ? ':shortest=1' : ''}[o${i}]`);
    cur = `[o${i}]`;
    if (midIn[i] != null) { f.push(`${cur}[${midIn[i]}:v]overlay=0:0:format=rgb[m${i}]`); cur = `[m${i}]`; }
  });
  // Burned-in captions (the Video panel's option; server/export-words.mjs), on top of everything.
  cur = burnCaptions(dir, { f, cur, jobRel, W, H, captions: body.captions, parts: [{ kind: 'take', segs, total, start: 0, blocks: null }] });
  f.push(`${cur}scale=out_color_matrix=bt709:out_range=tv,format=yuv420p[vout]`);
  // Sound: the canvas take's (webcam first), plus any layer whose sound is switched on, cut the same way.
  const maps = ['-map', '[vout]'];
  const sounds = [];
  if (info.audio) sounds.push(info.sources[info.audio]);
  for (const x of layout.layers) if (x.audio && info.layerAudio[x.file] && !sounds.includes(x.file)) sounds.push(x.file);
  sounds.forEach((file, i) => {
    const aIn = vid[file] ?? input(['-i', `source/${file}`]);
    f.push(`[${aIn}:a]aresample=48000:first_pts=0,asetnsamples=n=${48000 / FPS}:p=0` +
      (sel ? `,aselect='${sel}',asetpts=N/SR/TB` : '') + (sounds.length > 1 ? `[s${i}]` : '[aout]'));
  });
  if (sounds.length > 1) f.push(`${sounds.map((_, i) => `[s${i}]`).join('')}amix=inputs=${sounds.length}:duration=first:normalize=0[aout]`);
  // Sound cues from the Sound panel (work/sfx.json), mixed under the voice (server/sound.mjs).
  const sfx = mixCues(dir, { f, input, segs, total, voice: sounds.length ? '[aout]' : null, voiceFile: sounds[0], skip: body.skipCue });
  if (sfx.label) maps.push('-map', sfx.label, '-c:a', 'aac', '-b:a', '256k');
  const out = nextName(dir, id, scene.preset);
  args.push('-filter_complex', f.join(';'), ...maps,
    ...h264('16M'), '-profile:v', 'high',
    '-colorspace', 'bt709', '-color_primaries', 'bt709', '-color_trc', 'bt709', '-color_range', 'tv',
    '-t', total.toFixed(3), '-movflags', '+faststart', '-f', 'mp4', `${out}.part`);

  const ffmpeg = studioTool('ffmpeg');
  writeJSON(join(dir, jobRel, 'job.json'), {
    out, layout, scene, sources: info.sources, dims: info.dims, audio: sounds,
    background: bgPlan ? { ...bgPlan.bg, file: bgPlan.file || bgPlan.bg.file, frames: bgPlan.frames } : layout.bg,
    cut: cut ? { file: cut.file, segments: segs } : null, duration: total, ffmpeg: [ffmpeg, ...args],
  });
  const sh = join(dir, jobRel, 'run.sh');
  writeFileSync(sh, `#!/bin/sh\n# Re-run this export from the project folder.\ncd "$(dirname "$0")/../../.." || exit 1\n` +
    `${[ffmpeg, ...args.filter((a) => a !== '-progress' && a !== 'pipe:1')].map(quote).join(' ')} && mv ${quote(out + '.part')} ${quote(out)}\n`);
  chmodSync(sh, 0o755);

  const label = `Exporting ${out.replace('renders/', '')} (${total.toFixed(1)} s${cut ? ', locked cut' : ''})`;
  let bgPct = -1;
  const proc = spawnAfterBackground(ffmpeg, args, dir, bgPlan, (p, ready) => {
    if (!ready && Math.floor(p * 100) === bgPct) return;
    bgPct = Math.floor(p * 100);
    emit({ t: 'job', id: 'export', label: ready ? label : `Rendering the ${bgPlan.label} background (${bgPct}%) · ${label}`, progress: ready ? 0 : p, cancel: true });
  });
  const job = { proc, label, progress: 0, out, cancelled: false, started: Date.now() };
  jobs.set(id, job);
  emit({ t: 'job', id: 'export', label, progress: 0, cancel: true });
  let err = '';
  proc.stderr.on('data', (d) => { err = (err + d).slice(-3000); });
  proc.stdout.on('data', (d) => {
    const m = /out_time_(?:us|ms)=(\d+)/g;
    let last = null, x;
    while ((x = m.exec(String(d)))) last = x;
    if (last && total) {
      job.progress = Math.min(0.99, Number(last[1]) / 1e6 / total);
      emit({ t: 'job', id: 'export', label, progress: job.progress, cancel: true });
    }
  });
  proc.on('exit', (code) => {
    jobs.delete(id);
    const part = join(dir, `${out}.part`);
    const ok = code === 0 && existsSync(part);
    if (ok) {
      renameSync(part, join(dir, out));
      const secs = ((Date.now() - job.started) / 1000).toFixed(0);
      appendWorklog(dir, `Exported ${out} (${scene.preset}, ${layout.aspect}, ${total.toFixed(1)} s${cut ? `, cut from ${cut.file}` : ', whole take'}${body.captions ? ', captions burned in' : ''}; job ${jobRel}, ${secs} s)`);
      logTrialUse(dir, relative(settings().studio, dir), { bg: layout.bg, preset: scene.preset, out });
      let bytes = 0;
      try { bytes = statSync(join(dir, out)).size; } catch {}
      emit({ t: 'job', id: 'export', label: `Exported ${out}`, progress: 1, done: true, ok: true, file: out,
        receipt: { file: out, preset: scene.preset, aspect: layout.aspect, duration: total,
          cut: cut ? cut.file : null, seconds: Number(secs), bytes, at: Date.now() } });
    } else {
      try { rmSync(part, { force: true }); } catch {}
      const why = job.cancelled ? 'Export stopped' : `Export failed (ffmpeg ${code}): ${err.trim().split('\n').slice(-2).join(' ')}`;
      emit({ t: 'job', id: 'export', label: why, progress: 1, done: true, ok: job.cancelled });
    }
    emit({ t: 'files' });
  });
  return { out, duration: total, job: jobRel };
}

// The background under everything. An animated one (rendered frames, or a looping video) goes first with
// the canvas's base PNG (here only the first card's shadow) on top; a still one is already in the base PNG.
function backgroundChain(f, plan, bgIn, baseIn) {
  if (!plan) return `[${baseIn}:v]`;
  f.push(`[${bgIn}:v]${plan.filter}[bg]`, `[bg][${baseIn}:v]overlay=0:0:format=rgb:shortest=1[bgb]`);
  return '[bgb]';
}

// The export's ffmpeg, started once a drawn background is rendered (plan.prepare). It looks like the child
// process (stdout, stderr, 'exit', kill), so the job code doesn't care which; kill stops either stage.
function spawnAfterBackground(cmd, args, cwd, plan, onStage) {
  if (!plan?.prepare) return spawn(cmd, args, { cwd });
  const ev = new EventEmitter();
  ev.stdout = new PassThrough(); ev.stderr = new PassThrough();
  let child = null, render = null, killed = false;
  ev.kill = (sig) => { killed = true; if (child) child.kill(sig); else render?.cancel(); };
  try { render = plan.prepare((p) => onStage(p, false)); } catch (e) {
    setImmediate(() => { ev.stderr.write(e.message); ev.emit('exit', 1); });
    return ev;
  }
  render.done.then(() => {
    if (killed) return ev.emit('exit', null);
    onStage(1, true);
    child = spawn(cmd, args, { cwd });
    child.stdout.pipe(ev.stdout); child.stderr.pipe(ev.stderr);
    child.on('exit', (code) => ev.emit('exit', code));
  }, (e) => { ev.stderr.write(`\n${e.message}`); ev.emit('exit', killed ? null : 1); });
  return ev;
}

export function cancelExport(id) {
  const job = jobs.get(id);
  if (!job) return false;
  job.cancelled = true;
  job.proc.kill('SIGTERM');
  return true;
}

export const stopAllExports = () => { for (const j of jobs.values()) { j.cancelled = true; j.proc.kill('SIGTERM'); } };

// ---- blocks (M3b): the video as a row of blocks ----
// When work/blocks.json changes the video (a block with its own file, take blocks in another order, a block with its
// own layout), every part renders on its own with the same canvas layout (the canvas sends a set of PNG layers per
// block that looks different), and the parts are joined in order. Take parts are cut by the locked cut, file blocks
// keep their own sound. Parts are H.264 + PCM in .mov (sample-exact joins), joined with the concat demuxer.
function exportSequence(id, dir, body, emit, seq) {
  const layout = normalize(body.layout, projectMeta(dir)?.type);
  const info = exportInfo(id, dir);
  if (!info.duration) throw new Error('Nothing to export yet: add a recording first.');
  const now = new Date(), two = (v) => String(v).padStart(2, '0');
  const stamp = `${now.getFullYear()}${two(now.getMonth() + 1)}${two(now.getDate())}_${two(now.getHours())}${two(now.getMinutes())}${two(now.getSeconds())}`;
  const jobRel = `work/export/${stamp}`;
  mkdirSync(join(dir, jobRel), { recursive: true });
  mkdirSync(join(dir, 'renders'), { recursive: true });
  const labels = Object.fromEntries(seq.doc.blocks.map((b) => [b.id, b.label]));

  const parts = seq.parts.map((p, k) => {
    const tag = `p${String(k).padStart(2, '0')}`;
    let scene, pngs, segs = null, total, src, dims, sounds = [], name;
    if (p.kind === 'take') {
      scene = compose(p.layout ? { ...layout, preset: p.layout } : layout, info.dims);
      pngs = p.layout ? (body.blockPngs || body.pngs?.blocks)?.[p.blocks[0]] : body.pngs;
      segs = snapSegments(p.segs, info.duration);
      total = segs.reduce((t, [a, b]) => t + b - a, 0);
      src = { screen: info.sources.screen && `source/${info.sources.screen}`, cam: info.sources.cam && `source/${info.sources.cam}`,
        audio: info.sources.audio && `source/${info.sources.audio}` };
      dims = info.dims;
      if (info.audio) sounds.push(src[info.audio]);
      for (const x of layout.layers) if (x.audio && info.layerAudio[x.file] && !sounds.includes(`source/${x.file}`)) sounds.push(`source/${x.file}`);
      name = p.blocks.map((b) => labels[b]).filter((v, i, a) => a.indexOf(v) === i).join(' + ');
    } else {
      const fi = p.info;
      scene = compose(blockLayout(layout, p.block), fi.dims);
      pngs = (body.blockPngs || body.pngs?.blocks)?.[p.block.id];
      total = Math.floor(fi.duration * FPS) / FPS;
      src = { screen: fi.files.screen && `source/${fi.files.screen}`, cam: fi.files.cam && `source/${fi.files.cam}`,
        audio: fi.files.audio && `source/${fi.files.audio}` };
      dims = fi.dims;
      if (fi.audio) sounds.push(src.cam || src.screen || src.audio);
      name = `${p.block.label} (own file)`;
    }
    // A sound-only part (a mic-only take or a voiceover block) is the background with that sound.
    if ((!scene.layers.length && !sounds.length) || !(total > 0)) return null;
    if (!pngs) throw new Error(`The canvas didn't send the picture layers for "${name}". Reload the page and try again.`);
    const { W, H } = scene;
    const files = { base: pngFrom(pngs.base, W, H, `${name} background`) };
    scene.layers.forEach((ly, i) => {
      files[`mask${i}`] = pngFrom(pngs[`mask${i}`], ly.box.w, ly.box.h, `${name} ${ly.role} mask`);
      if (pngs[`mid${i}`]) files[`mid${i}`] = pngFrom(pngs[`mid${i}`], W, H, `${name} ${ly.role} frame`);
    });
    for (const [key, buf] of Object.entries(files)) writeFileSync(join(dir, jobRel, `${tag}_${key}.png`), buf);
    return { tag, kind: p.kind, name, scene, segs, total, src, dims, sounds, mids: Object.keys(files).filter((x) => x.startsWith('mid')).map((x) => Number(x.slice(3))),
      blocks: p.kind === 'take' ? p.blocks : [p.block.id], out: `${jobRel}/${tag}.mov` };
  }).filter(Boolean);
  if (!parts.length) throw new Error('The blocks leave nothing to export.');

  const ffmpeg = studioTool('ffmpeg');
  const half = 0.5 / FPS;
  // Where each part starts in the finished video; an animated background is planned once for the whole video and
  // each part takes its own stretch of it, so it runs on across the joins. Sound cues sit on the take: each take
  // part mixes the ones inside its blocks.
  let at = 0;
  for (const p of parts) { p.start = at; at += p.total; }
  const seqTotal = at;
  const main = compose(layout, info.dims);
  const bgPlan = backgroundPlan(id, dir, layout, { W: main.W, H: main.H, total: seqTotal, jobRel });
  const rangeOf = (p) => { const r = p.blocks.map((b) => seq.doc.blocks.find((x) => x.id === b)?.source.take).filter(Boolean); return r.length ? [Math.min(...r.map((x) => x[0])), Math.max(...r.map((x) => x[1]))] : null; };
  const argsFor = (part) => {
    const args = ['-y', '-v', 'error', '-nostats', '-progress', 'pipe:1'];
    let n = 0;
    const input = (list) => { args.push(...list); return n++; };
    const { scene, total } = part;
    const sel = part.segs ? part.segs.map(([a, b]) => `gte(t,${(a - half).toFixed(5)})*lt(t,${(b - half).toFixed(5)})`).join('+') : null;
    const fileOf = (ly) => (ly.role === 'layer' ? `source/${ly.file}` : part.src[ly.role]);
    const dimsOf = (ly) => (ly.role === 'layer' ? part.dims.files[ly.file] : part.dims[ly.role]);
    const vid = {};
    for (const ly of scene.layers) vid[fileOf(ly)] ??= input([...videoDecodeArgs(), '-i', fileOf(ly)]);
    const still = (key) => input(['-loop', '1', '-framerate', String(FPS), '-t', total.toFixed(3), '-i', `${jobRel}/${part.tag}_${key}.png`]);
    const bgIn = bgPlan ? input(bgPlan.input) : null;
    const baseIn = still('base');
    const maskIn = scene.layers.map((_, i) => still(`mask${i}`));
    const midIn = scene.layers.map((_, i) => (part.mids.includes(i) ? still(`mid${i}`) : null));
    const f = [];
    const pick = sel ? `,select='${sel}',setpts=N/${FPS}/TB` : '';
    scene.layers.forEach((ly, i) => {
      const p = dimsOf(ly);
      const cw = Math.round(ly.crop.w * p[0]), ch = Math.round(ly.crop.h * p[1]);
      const cx = 2 * Math.round((ly.crop.x * p[0]) / 2), cy = 2 * Math.round((ly.crop.y * p[1]) / 2);
      f.push(`[${vid[fileOf(ly)]}:v]setpts=PTS-STARTPTS,fps=${FPS}${pick},crop=${cw}:${ch}:${cx}:${cy},` +
        `scale=${ly.box.w}:${ly.box.h}:flags=lanczos${ly.mirror ? ',hflip' : ''},format=rgba[v${i}]`);
      f.push(`[${maskIn[i]}:v]format=gray[k${i}]`, `[v${i}][k${i}]alphamerge=shortest=1[a${i}]`);
    });
    let cur = backgroundChain(f, bgPlan && { ...bgPlan, filter: `${bgPlan.filter},trim=start=${part.start.toFixed(5)}:duration=${total.toFixed(5)},setpts=PTS-STARTPTS` }, bgIn, baseIn);
    scene.layers.forEach((ly, i) => {
      f.push(`${cur}[a${i}]overlay=${ly.box.x}:${ly.box.y}:format=rgb${i === 0 ? ':shortest=1' : ''}[o${i}]`);
      cur = `[o${i}]`;
      if (midIn[i] != null) { f.push(`${cur}[${midIn[i]}:v]overlay=0:0:format=rgb[m${i}]`); cur = `[m${i}]`; }
    });
    cur = burnCaptions(dir, { f, cur, jobRel, W: scene.W, H: scene.H, captions: body.captions, parts, doc: seq.doc, from: part.start, to: part.start + total, tag: part.tag });
    f.push(`${cur}scale=out_color_matrix=bt709:out_range=tv,format=yuv420p[vout]`);
    // Every part gets stereo 48 kHz sound (silence when it has none), so the parts join without gaps.
    if (part.sounds.length) {
      part.sounds.forEach((file, i) => {
        const aIn = vid[file] ?? input(['-i', file]);
        f.push(`[${aIn}:a]aresample=48000:first_pts=0,asetnsamples=n=${48000 / FPS}:p=0` + (sel ? `,aselect='${sel}',asetpts=N/SR/TB` : '') + `[s${i}]`);
      });
      f.push(part.sounds.length > 1 ? `${part.sounds.map((_, i) => `[s${i}]`).join('')}amix=inputs=${part.sounds.length}:duration=first:normalize=0[sm]` : `[s0]anull[sm]`);
    } else {
      const sil = input(['-f', 'lavfi', '-t', total.toFixed(3), '-i', 'anullsrc=r=48000:cl=stereo']);
      f.push(`[${sil}:a]anull[sm]`);
    }
    const cues = part.kind === 'take' ? mixCues(dir, { f, input, segs: part.segs, total, voice: '[sm]', voiceFile: part.sounds[0]?.replace(/^source\//, ''), range: rangeOf(part), skip: body.skipCue }) : { label: '[sm]', cues: 0 };
    part.cues = cues.cues;
    f.push(`${cues.label}aformat=sample_fmts=s16:sample_rates=48000:channel_layouts=stereo[aout]`);
    args.push('-filter_complex', f.join(';'), '-map', '[vout]', '-map', '[aout]',
      ...h264('16M'), '-profile:v', 'high',
      '-colorspace', 'bt709', '-color_primaries', 'bt709', '-color_trc', 'bt709', '-color_range', 'tv',
      '-c:a', 'pcm_s16le', '-t', total.toFixed(3), '-f', 'mov', part.out);
    return args;
  };

  const preset = compose(layout, info.dims).preset;
  const out = nextName(dir, id, preset);
  const total = parts.reduce((t, p) => t + p.total, 0);
  writeFileSync(join(dir, jobRel, 'parts.txt'), parts.map((p) => `file '${p.tag}.mov'`).join('\n') + '\n');
  const joinArgs = ['-y', '-v', 'error', '-nostats', '-progress', 'pipe:1', '-f', 'concat', '-safe', '0', '-i', `${jobRel}/parts.txt`,
    '-c:v', 'copy', '-c:a', 'aac', '-b:a', '256k', '-movflags', '+faststart', '-f', 'mp4', `${out}.part`];
  const runs = parts.map((p) => argsFor(p));
  writeJSON(join(dir, jobRel, 'job.json'), {
    out, layout, blocks: seq.doc.blocks, cut: seq.cutFile, duration: total,
    background: bgPlan ? { ...bgPlan.bg, file: bgPlan.file || bgPlan.bg.file, frames: bgPlan.frames } : layout.bg,
    parts: parts.map((p) => ({ file: p.out, kind: p.kind, name: p.name, blocks: p.blocks, duration: p.total, segments: p.segs, sources: p.src, preset: p.scene.preset })),
    ffmpeg: [...runs.map((a) => [ffmpeg, ...a]), [ffmpeg, ...joinArgs]],
  });
  const sh = join(dir, jobRel, 'run.sh');
  const line = (a) => [ffmpeg, ...a.filter((x) => x !== '-progress' && x !== 'pipe:1')].map(quote).join(' ');
  writeFileSync(sh, `#!/bin/sh\n# Re-run this export from the project folder: each block part, then the join.\ncd "$(dirname "$0")/../../.." || exit 1\nset -e\n` +
    runs.map(line).join('\n') + `\n${line(joinArgs)} && mv ${quote(out + '.part')} ${quote(out)}\n`);
  chmodSync(sh, 0o755);

  const label = `Exporting ${out.replace('renders/', '')} (${total.toFixed(1)} s, ${parts.length} parts${seq.cutFile ? ', locked cut' : ''})`;
  const job = { proc: null, label, progress: 0, out, cancelled: false, started: Date.now() };
  jobs.set(id, job);
  emit({ t: 'job', id: 'export', label, progress: 0, cancel: true });
  let done = 0, err = '';
  // A drawn background is rendered first (frames, server/backgrounds.mjs), then the parts.
  const begin = () => {
    if (!bgPlan?.prepare) return step(0);
    let render;
    try { render = bgPlan.prepare((p) => { job.progress = 0; emit({ t: 'job', id: 'export', label: `Rendering the ${bgPlan.label} background (${Math.floor(p * 100)}%) · ${label}`, progress: p, cancel: true }); }); }
    catch (e) { err = e.message; return finish(false, 1); }
    job.proc = { kill: () => render.cancel() };
    render.done.then(() => step(0), (e) => { err = e.message; finish(false, 1); });
  };
  const step = (k) => {
    if (job.cancelled) return finish(false);
    const last = k === parts.length;
    const args = last ? joinArgs : runs[k];
    const span = last ? total * 0.03 : parts[k].total;
    const proc = spawn(ffmpeg, args, { cwd: dir });
    job.proc = proc;
    proc.stderr.on('data', (d) => { err = (err + d).slice(-3000); });
    proc.stdout.on('data', (d) => {
      const m = /out_time_(?:us|ms)=(\d+)/g;
      let x, lastM = null;
      while ((x = m.exec(String(d)))) lastM = x;
      if (!lastM) return;
      const cur = Math.min(span, (Number(lastM[1]) / 1e6) * (last ? 0.03 : 1));
      job.progress = Math.min(0.99, (done + cur) / (total * 1.03));
      emit({ t: 'job', id: 'export', label: last ? `${label}: joining the parts` : `${label}: ${parts[k].name}`, progress: job.progress, cancel: true });
    });
    let ended = false;
    // ffmpeg missing or not startable: the export fails with that, never the server (an unhandled spawn error).
    proc.on('error', (e) => { if (ended) return; ended = true; err = e.code === 'ENOENT' ? `ffmpeg isn't on this computer: Setup → Tools installs it.` : e.message; finish(false, 1); });
    proc.on('exit', (code) => {
      if (ended) return;
      ended = true;
      if (code !== 0 || job.cancelled) return finish(false, code);
      done += span;
      if (last) return finish(true);
      step(k + 1);
    });
  };
  const finish = (ok, code) => {
    jobs.delete(id);
    const part = join(dir, `${out}.part`);
    if (ok && existsSync(part)) {
      renameSync(part, join(dir, out));
      const secs = ((Date.now() - job.started) / 1000).toFixed(0);
      const cueCount = parts.reduce((t, p) => t + (p.cues || 0), 0);
      appendWorklog(dir, `Exported ${out} (${preset}, ${layout.aspect}, ${total.toFixed(1)} s, blocks: ${parts.map((p) => p.name).join(' · ')}${seq.cutFile ? `; cut from ${seq.cutFile}` : ''}${cueCount ? `; ${cueCount} sound cue${cueCount > 1 ? 's' : ''}` : ''}${body.captions ? '; captions burned in' : ''}; job ${jobRel}, ${secs} s)`);
      logTrialUse(dir, relative(settings().studio, dir), { bg: layout.bg, preset, out });
      let bytes = 0;
      try { bytes = statSync(join(dir, out)).size; } catch {}
      emit({ t: 'job', id: 'export', label: `Exported ${out}`, progress: 1, done: true, ok: true, file: out,
        receipt: { file: out, preset, aspect: layout.aspect, duration: total, cut: seq.cutFile, seconds: Number(secs), bytes, at: Date.now(), blocks: parts.map((p) => p.name) } });
    } else {
      try { rmSync(part, { force: true }); } catch {}
      const why = job.cancelled ? 'Export stopped' : `Export failed (ffmpeg ${code}): ${err.trim().split('\n').slice(-2).join(' ')}`;
      emit({ t: 'job', id: 'export', label: why, progress: 1, done: true, ok: job.cancelled });
    }
    emit({ t: 'files' });
  };
  begin();
  return { out, duration: total, job: jobRel, parts: parts.length };
}
