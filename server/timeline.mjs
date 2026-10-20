// Data for the timeline under the canvas: the canvas take's word times and a waveform of its sound.
// The waveform is read once from the playback copy with ffmpeg and cached next to it in work/.
import { existsSync, statSync } from 'node:fs';
import { join, basename, extname } from 'node:path';
import { spawn } from 'node:child_process';
import { readJSON, writeJSON, mtime, studioTool } from './util.mjs';
import { projectMeta, proxyName, roles, lockedCut } from './studio.mjs';
import { canvasSources } from './export.mjs';

const RATE = 50;          // peaks per second
const SAMPLE_RATE = 4000; // mono samples per second read from ffmpeg

const pending = new Map();

// Peak level (0–100) of a source file's sound for every 1/RATE s (read from its playback copy).
function peaksFor(dir, file) {
  const proxy = join(dir, proxyName(file));
  const src = existsSync(proxy) ? proxy : join(dir, 'source', file);
  return peaksOf(src, join(dir, 'work', `peaks_${basename(file, extname(file))}.json`), file);
}

// The same for any video in the project, such as a render (renders/x.mp4 → work/peaks_render_x.json).
export function filePeaks(dir, rel) {
  return peaksOf(join(dir, rel), join(dir, 'work', `peaks_render_${basename(rel, extname(rel))}.json`), rel)
    .then((p) => p && { rate: p.rate, data: p.data });
}

function peaksOf(src, cache, file) {
  if (!existsSync(src)) return Promise.resolve(null);
  const stamp = statSync(src).mtimeMs;
  const hit = readJSON(cache, null);
  if (hit && hit.stamp === stamp && hit.rate === RATE) return Promise.resolve(hit);
  if (pending.has(cache)) return pending.get(cache);
  const job = new Promise((done) => {
    const ff = spawn(studioTool('ffmpeg'), ['-v', 'error', '-i', src, '-vn', '-ac', '1', '-ar', String(SAMPLE_RATE), '-f', 's16le', 'pipe:1']);
    const per = SAMPLE_RATE / RATE;
    const data = [];
    let peak = 0, n = 0, carry = null;
    ff.stdout.on('data', (buf) => {
      if (carry) { buf = Buffer.concat([carry, buf]); carry = null; }
      const even = buf.length - (buf.length % 2);
      if (even < buf.length) carry = buf.subarray(even);
      for (let i = 0; i < even; i += 2) {
        const v = Math.abs(buf.readInt16LE(i));
        if (v > peak) peak = v;
        if (++n === per) { data.push(Math.round((peak / 32768) * 100)); peak = 0; n = 0; }
      }
    });
    ff.on('error', () => done(null));
    ff.on('close', (code) => {
      if (n) data.push(Math.round((peak / 32768) * 100));
      if (code !== 0 || !data.length) return done(null);
      const out = { file, stamp, rate: RATE, data };
      try { writeJSON(cache, out); } catch {}
      done(out);
    });
  }).finally(() => pending.delete(cache));
  pending.set(cache, job);
  return job;
}

export async function timelineData(dir) {
  const c = canvasSources(dir);
  const master = c.cam || c.screen || c.audio || null; // a mic-only take: its WAV, read directly (no playback copy)
  // Word times belong to the take they were transcribed from: ignore files older than the canvas take.
  const since = projectMeta(dir)?.activeSince || 0;
  const wordsFile = ['work/tr/words.json', 'work/words.json'].find((f) => existsSync(join(dir, f)) && mtime(join(dir, f)) > since) || null;
  const raw = wordsFile ? readJSON(join(dir, wordsFile), []) : [];
  const words = (Array.isArray(raw) ? raw : []).filter((w) => Array.isArray(w) && w.length >= 3 && Number.isFinite(w[0]) && Number.isFinite(w[1]))
    .map(([a, b, t]) => [a, b, String(t)]);
  const peaks = master ? await peaksFor(dir, master) : null;
  return { master, wordsFile, words, peaks: peaks && { rate: peaks.rate, data: peaks.data } };
}

// The join check's flags (work/joins.json) for the canvas timeline: joins it thinks clipped a word ("likely clipped",
// red) or wants you to hear ("check", amber), on the canvas take's time, where the kept part before the join ends.
// Only when the check ran on this take (its source is a file of the canvas take, or its playback copy). With a locked
// cut, a join that no longer ends one of its kept parts is left out: the cut changed since the check.
export function joinFlags(dir) {
  const path = join(dir, 'work', 'joins.json');
  const j = readJSON(path, null);
  if (!Array.isArray(j?.joins) || mtime(path) < (projectMeta(dir)?.activeSince || 0)) return [];
  const src = basename(String(j.source || ''));
  if (!src || !roles(dir).take.some((f) => f === src || basename(proxyName(f)) === src)) return [];
  const ends = (lockedCut(dir)?.segments || []).slice(0, -1).map((s) => Number(s[1]));
  return j.joins.filter((x) => ['likely clipped', 'check'].includes(x?.status) && Number.isFinite(x.src_out))
    .filter((x) => !ends.length || ends.some((e) => Math.abs(e - x.src_out) < 0.35))
    .map((x) => ({ k: x.k, t: x.src_out, tIn: Number.isFinite(x.src_in) ? x.src_in : x.src_out, status: x.status === 'check' ? 'check' : 'clipped',
      score: x.score ?? null, word: x.out?.word || x.in?.word || null, heard: x.heard || null, expected: x.expected || null }))
    .sort((a, b) => a.t - b.t);
}
