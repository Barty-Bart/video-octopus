// Audio export (the Export panel's Audio kind): the final timeline's sound as one file, mixed exactly like the video
// export (server/export.mjs): the canvas take's sound (camera first) plus any layer whose sound is on, cut by the
// locked cut, sound cues under the voice (server/sound.mjs), blocks in order with file blocks' own sound. Formats:
// WAV 24-bit 48 kHz, AAC 256 kbps (.m4a) or MP3 320 kbps; contents Full mix or Voice only; an optional loudness target
// (−14 LUFS for YouTube, −16 for podcasts): measured, gained to the target, then a peak limiter at −1 dBFS.
// Every part renders to PCM first (sample-exact, the same length as the video's part), the parts join, then the
// file is encoded. Output: renders/<project>_mix_vN.<ext> or _voice_vN; the job folder work/export/<time>_audio/
// keeps job.json and run.sh.
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, renameSync, rmSync, statSync, writeFileSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import { studioTool, writeJSON } from './util.mjs';
import { appendWorklog, projectMeta } from './studio.mjs';
import { exportInfo } from './export.mjs';
import { planParts, layersRunning } from './export-layers.mjs';
import { mixCues, readCues } from './sound.mjs';
import { FPS } from '../web/layout.js';

const jobs = new Map(); // project id -> running audio export
const SR = 48000, SPF = SR / FPS; // samples per video frame
const HEAD = ['-y', '-v', 'error', '-nostats', '-progress', 'pipe:1'];
const two = (v) => String(v).padStart(2, '0');
const quote = (a) => (/^[\w./:=@%+-]+$/.test(a) ? a : `'${String(a).replace(/'/g, `'\\''`)}'`);

export const FORMATS = {
  wav: { ext: 'wav', label: 'WAV · 24-bit · 48 kHz', args: () => ['-c:a', 'pcm_s24le', '-f', 'wav'] },
  // ffmpeg's own AAC, the encoder the video export uses: the same sound, and the file ends where the video ends.
  aac: { ext: 'm4a', label: 'AAC · 256 kbps', args: () => ['-c:a', 'aac', '-b:a', '256k', '-movflags', '+faststart', '-f', 'ipod'] },
  mp3: { ext: 'mp3', label: 'MP3 · 320 kbps', args: () => ['-c:a', 'libmp3lame', '-b:a', '320k', '-id3v2_version', '3', '-f', 'mp3'] },
};
export const audioRunning = (id) => jobs.has(id);

function nextAudio(dir, id, contents, ext) {
  const base = `${id}_${contents}`;
  let n = 1;
  try {
    for (const f of readdirSync(join(dir, 'renders'))) {
      const m = new RegExp(`^${base.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}_v(\\d+)\\.(wav|m4a|mp3)$`).exec(f);
      if (m) n = Math.max(n, Number(m[1]) + 1);
    }
  } catch {}
  return `renders/${base}_v${n}.${ext}`;
}

// What the panel shows: the final timeline (length, parts), the sounds that go in, the next file names.
export function audioInfo(id, dir, q = {}) {
  let plan = null, error = null;
  try { plan = planParts(id, dir, { useCut: q.useCut !== '0' && q.useCut !== false }); } catch (e) { error = e.message; }
  const info = exportInfo(id, dir);
  const layers = (projectMeta(dir)?.layout?.layers || []).filter((x) => x.audio && info.layerAudio[x.file]).length;
  const next = {};
  for (const c of ['mix', 'voice']) for (const [k, f] of Object.entries(FORMATS)) next[`${c}.${k}`] = nextAudio(dir, id, c, f.ext);
  return {
    error, duration: plan ? plan.frames / FPS : 0, frames: plan?.frames || 0, cut: plan?.useCut && plan.cut ? plan.cut.file : null,
    parts: plan ? plan.parts.map((p) => ({ kind: p.kind, name: p.name, total: p.frames / FPS, sound: p.sounds.length > 0 })) : [],
    voice: info.audio, layers, cues: readCues(dir).length, next,
    running: jobs.get(id)?.last || null,
  };
}

// One part's sound as PCM, the same chain as the video export's part: the voice (cut like the picture, layers with
// sound mixed in), then the sound cues under it (full mix), stereo 48 kHz, exactly frames × 1600 samples long.
function partArgs(dir, part, out, mix, single) {
  const args = [...HEAD];
  let n = 0;
  const input = (l) => { args.push(...l); return n++; };
  const f = [];
  const half = 0.5 / FPS;
  const sel = part.segs ? part.segs.map(([a, b]) => `gte(t,${(a - half).toFixed(5)})*lt(t,${(b - half).toFixed(5)})`).join('+') : null;
  let label = null;
  if (part.sounds.length) {
    part.sounds.forEach((file, i) => {
      const k = input(['-i', file]);
      f.push(`[${k}:a]aresample=48000:first_pts=0,asetnsamples=n=${SPF}:p=0` + (sel ? `,aselect='${sel}',asetpts=N/SR/TB` : '') + `[s${i}]`);
    });
    f.push(part.sounds.length > 1 ? `${part.sounds.map((_, i) => `[s${i}]`).join('')}amix=inputs=${part.sounds.length}:duration=first:normalize=0[vo]` : '[s0]anull[vo]');
    label = '[vo]';
  } else if (!single || !mix) {
    // Block exports give every part sound (silence when it has none), so the parts join without gaps.
    const k = input(['-f', 'lavfi', '-t', (part.frames / FPS).toFixed(6), '-i', 'anullsrc=r=48000:cl=stereo']);
    f.push(`[${k}:a]anull[vo]`);
    label = '[vo]';
  }
  let cues = 0;
  if (mix && part.kind === 'take') {
    // A plain export mixes the cues over the voice (or, with no sound, over silence); block parts mix their own range.
    const r = mixCues(dir, { f, input, segs: part.segs, total: part.total, voice: label, voiceFile: part.sounds[0]?.replace(/^source\//, ''), range: single ? null : part.range });
    label = r.label; cues = r.cues;
  }
  if (!label) {
    const k = input(['-f', 'lavfi', '-t', (part.frames / FPS).toFixed(6), '-i', 'anullsrc=r=48000:cl=stereo']);
    f.push(`[${k}:a]anull[vo]`);
    label = '[vo]';
  }
  const len = part.frames * SPF;
  f.push(`${label}aformat=sample_fmts=s32:sample_rates=48000:channel_layouts=stereo,apad=whole_len=${len},atrim=end_sample=${len}[aout]`);
  args.push('-filter_complex', f.join(';'), '-map', '[aout]', '-c:a', 'pcm_s24le', '-f', 'wav', out);
  return { args, cues, sound: part.sounds.length > 0 };
}

function run(job, args, { cwd, onTime, keepErr } = {}) {
  return new Promise((resolve, reject) => {
    if (job.cancelled) return reject(new Error('stopped'));
    const proc = spawn(studioTool('ffmpeg'), args, { cwd });
    job.proc = proc;
    let err = '';
    proc.stderr.on('data', (d) => { err = keepErr ? err + d : (err + d).slice(-3000); });
    proc.stdout.on('data', (d) => {
      const t = [...String(d).matchAll(/out_time_(?:us|ms)=(\d+)/g)].pop();
      if (t && onTime) onTime(Number(t[1]) / 1e6);
    });
    proc.on('error', reject);
    proc.on('exit', (code) => {
      job.proc = null;
      if (job.cancelled) return reject(new Error('stopped'));
      code === 0 ? resolve(err) : reject(new Error(`ffmpeg ${code}: ${err.trim().split('\n').slice(-2).join(' ')}`));
    });
  });
}

export function startAudioExport(id, dir, body, emit) {
  if (jobs.has(id) || exportInfo(id, dir).running || layersRunning(id)) throw new Error('An export is already running for this project.');
  const fmt = FORMATS[body.format] ? body.format : 'wav';
  const contents = body.contents === 'voice' ? 'voice' : 'mix';
  const target = [-14, -16].includes(Number(body.loudness)) ? Number(body.loudness) : null;
  const plan = planParts(id, dir, { layout: body.layout, useCut: body.useCut !== false });
  const { parts, frames: N } = plan;
  const total = N / FPS;
  const single = !plan.seq;
  if (!parts.some((p) => p.sounds.length) && (contents === 'voice' || !readCues(dir).length)) throw new Error('This video has no sound to export.');
  const now = new Date();
  const stamp = `${now.getFullYear()}${two(now.getMonth() + 1)}${two(now.getDate())}_${two(now.getHours())}${two(now.getMinutes())}${two(now.getSeconds())}`;
  let rel = `work/export/${stamp}_audio`;
  for (let k = 2; existsSync(join(dir, rel)); k++) rel = `work/export/${stamp}_audio${k}`;
  mkdirSync(join(dir, rel), { recursive: true });
  mkdirSync(join(dir, 'renders'), { recursive: true });
  const out = nextAudio(dir, id, contents, FORMATS[fmt].ext);
  const ffmpeg = studioTool('ffmpeg');

  const runs = parts.map((p) => ({ part: p, ...partArgs(dir, p, `${rel}/${p.tag}.wav`, contents === 'mix', single) }));
  const cueCount = runs.reduce((t, r) => t + r.cues, 0);
  const joined = runs.length > 1 ? `${rel}/joined.wav` : runs[0] ? `${rel}/${parts[0].tag}.wav` : null;
  const commands = runs.map((r) => [ffmpeg, ...r.args]);
  const what = contents === 'voice' ? 'Voice only' : `Full mix${cueCount ? ` (voice + ${cueCount} sound cue${cueCount > 1 ? 's' : ''})` : ''}`;
  const label = `Exporting ${out.replace('renders/', '')} (${what}, ${total.toFixed(1)} s)`;
  const job = { proc: null, cancelled: false, started: Date.now(), last: null };
  jobs.set(id, job);
  const push = (progress, phase) => {
    job.last = { t: 'job', id: 'export', kind: 'audio', label: phase ? `${label} · ${phase}` : label, progress: Math.min(0.99, progress), cancel: true };
    emit(job.last);
  };
  // Progress: the parts (by length), then the loudness pass, then the encode.
  const weight = total + (target != null ? total * 0.5 : 0) + (fmt === 'wav' && target == null ? 0 : total * 0.3);
  let done = 0;
  const work = async () => {
    for (const r of runs) {
      push(done / weight, runs.length > 1 ? r.part.name : '');
      await run(job, r.args, { cwd: dir, onTime: (t) => push((done + Math.min(t, r.part.total)) / weight, runs.length > 1 ? r.part.name : '') });
      done += r.part.total;
    }
    if (runs.length > 1) {
      writeFileSync(join(dir, rel, 'parts.txt'), runs.map((r) => `file '${r.part.tag}.wav'`).join('\n') + '\n');
      const a = [...HEAD, '-f', 'concat', '-safe', '0', '-i', `${rel}/parts.txt`, '-c', 'copy', '-f', 'wav', joined];
      commands.push([ffmpeg, ...a]);
      await run(job, a, { cwd: dir });
    }
    // Loudness: measure the whole mix (EBU R128), gain it to the target, limit the peaks to −1 dBFS.
    let measured = null, gain = 0;
    if (target != null) {
      push(done / weight, 'measuring loudness');
      // loudnorm prints its measurement at the info level.
      const m = ['-y', '-v', 'info', '-nostats', '-progress', 'pipe:1', '-i', joined, '-af', `loudnorm=I=${target}:TP=-1:LRA=11:print_format=json`, '-f', 'null', '-'];
      const err = await run(job, m, { cwd: dir, keepErr: true, onTime: (t) => push((done + t * 0.5) / weight, 'measuring loudness') });
      const j = /\{[^{}]*"input_i"[^{}]*\}/s.exec(err);
      measured = j ? JSON.parse(j[0]) : null;
      const inI = Number(measured?.input_i);
      if (!Number.isFinite(inI) || inI < -70) throw new Error('Could not measure the loudness (is the sound silent?).');
      gain = Math.max(-30, Math.min(30, target - inI));
      done += total * 0.5;
    }
    const meta = ['-metadata', `title=${projectMeta(dir)?.name || id}`, '-metadata', `comment=${what}, made by Video Octopus`];
    const filters = (g) => (target != null ? ['-af', `volume=${g.toFixed(2)}dB,alimiter=limit=0.891:level=0:latency=1,apad=whole_len=${N * SPF},atrim=end_sample=${N * SPF}`] : []);
    const encode = async (g, phase) => {
      push(done / weight, phase);
      const e = [...HEAD, '-i', joined, ...filters(g), '-ar', String(SR), '-ac', '2', ...meta, ...FORMATS[fmt].args(), `${out}.part`];
      await run(job, e, { cwd: dir, onTime: (t) => push((done + t * 0.3) / weight, phase) });
      return [ffmpeg, ...e];
    };
    // What came out: its loudness and peak.
    const loudness = async () => {
      try {
        const err = await run(job, ['-v', 'info', '-nostats', '-i', `${out}.part`, '-af', 'ebur128=peak=sample', '-f', 'null', '-'], { cwd: dir, keepErr: true });
        const sum = err.slice(err.lastIndexOf('Summary:'));
        const r = { i: Number(/I:\s+(-?[\d.]+) LUFS/.exec(sum)?.[1]), peak: Number(/Peak:\s+(-?[\d.]+) dBFS/.exec(sum)?.[1]) };
        return Number.isFinite(r.i) ? r : null;
      } catch (e) { if (job.cancelled) throw e; return null; }
    };
    let after = null;
    if (fmt === 'wav' && target == null) renameSync(join(dir, joined), join(dir, `${out}.part`));
    else {
      let cmd = await encode(gain, 'encoding');
      if (target != null) {
        after = await loudness();
        // The limiter takes a little off the top: one more pass with the difference added lands on the target.
        if (after && Math.abs(after.i - target) > 0.15) {
          gain = Math.max(-30, Math.min(30, gain + target - after.i));
          cmd = await encode(gain, 'matching the loudness target');
          after = await loudness();
        }
      }
      commands.push(cmd);
    }
    return { measured, gain, after };
  };

  const sh = join(dir, rel, 'run.sh');
  const finish = (ok, res, e) => {
    jobs.delete(id);
    const part = join(dir, `${out}.part`);
    if (ok && existsSync(part)) {
      renameSync(part, join(dir, out));
      const secs = ((Date.now() - job.started) / 1000).toFixed(0);
      const loud = target != null ? `; ${String(target).replace("-", "−")} LUFS target: measured ${Number(res.measured.input_i).toFixed(1)}, gain ${res.gain >= 0 ? '+' : ''}${res.gain.toFixed(1)} dB${res.after && Number.isFinite(res.after.i) ? `, now ${res.after.i.toFixed(1)} LUFS, peak ${res.after.peak.toFixed(1)} dBFS` : ''}` : '';
      appendWorklog(dir, `Exported audio ${out} (${what}; ${FORMATS[fmt].label}; ${total.toFixed(3)} s = ${N} frames${plan.useCut && plan.cut ? `, cut from ${plan.cut.file}` : ', whole take'}` +
        `${parts.length > 1 ? `, blocks: ${parts.map((p) => p.name).join(' · ')}` : ''}${loud}; job ${rel}, ${secs} s)`);
      writeJSON(join(dir, rel, 'job.json'), { out, format: fmt, contents, loudness: target, measured: res.measured, gain: res.gain, after: res.after, duration: total, frames: N,
        cut: plan.useCut && plan.cut ? plan.cut.file : null, parts: parts.map((p) => ({ name: p.name, kind: p.kind, frames: p.frames, segments: p.segs, sounds: p.sounds })), ffmpeg: commands });
      writeFileSync(sh, `#!/bin/sh\n# Re-run this audio export from the project folder.\ncd "$(dirname "$0")/../../.." || exit 1\nset -e\n` +
        commands.map((c) => c.filter((a) => a !== '-progress' && a !== 'pipe:1').map(quote).join(' ')).join('\n') + `\n${fmt === 'wav' && target == null ? `mv ${quote(joined)} ${quote(out)}` : `mv ${quote(out + '.part')} ${quote(out)}`}\n`);
      chmodSync(sh, 0o755);
      let bytes = 0;
      try { bytes = statSync(join(dir, out)).size; } catch {}
      emit({ t: 'job', id: 'export', kind: 'audio', label: `Exported ${out}`, progress: 1, done: true, ok: true, out, bytes, duration: total, seconds: Number(secs), loudness: res.after });
    } else {
      try { rmSync(part, { force: true }); } catch {}
      const why = job.cancelled ? 'Audio export stopped' : `Audio export failed: ${e?.message || 'unknown error'}`;
      emit({ t: 'job', id: 'export', kind: 'audio', label: why, progress: 1, done: true, ok: job.cancelled });
    }
    // The PCM pieces go; job.json and run.sh stay.
    for (const r of runs) rmSync(join(dir, rel, `${r.part.tag}.wav`), { force: true });
    rmSync(join(dir, rel, 'joined.wav'), { force: true });
    emit({ t: 'files' });
  };
  push(0, '');
  work().then((res) => finish(true, res), (e) => finish(false, null, e));
  return { out, duration: total, frames: N, job: rel, parts: parts.length };
}

export function cancelAudio(id) {
  const job = jobs.get(id);
  if (!job) return false;
  job.cancelled = true;
  try { job.proc?.kill('SIGTERM'); } catch {}
  return true;
}
export const stopAllAudio = () => { for (const j of jobs.values()) { j.cancelled = true; try { j.proc?.kill('SIGTERM'); } catch {} } };

// Routes: GET /export-audio (what the panel shows), POST /export-audio (start).
export async function audioRoute(req, res, { id, dir, action, url, send, body, emit }) {
  if (action !== '/export-audio') return false;
  if (req.method === 'GET') { send(res, 200, audioInfo(id, dir, Object.fromEntries(url.searchParams))); return true; }
  const b = await body(req);
  try { send(res, 200, startAudioExport(id, dir, b, emit)); } catch (e) { send(res, 400, { error: e.message }); }
  return true;
}
