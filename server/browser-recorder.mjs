// The recorder: the page records the screen, camera and mic with MediaRecorder (an AudioWorklet for a mic-only
// take) and posts a chunk about every second; this file keeps those chunks on disk, in order, as
// <recordingsDir>/<stamp>/<stamp>_<track>.<ext>.part, and turns them into the usual take files when the take
// stops: <stamp>_screen.mp4 + <stamp>_webcam.mp4 (H.264, constant 30 fps, AAC 256k, trimmed to start and end
// together), <stamp>_webcam.mp4 alone, or <stamp>_audio.wav (24-bit PCM, 48 kHz). The take then goes into the
// project it was recorded for (takeArrived in index.mjs): replace, layer or block.
//
// Crash-safe: take.json in the take folder says which project the take is for, what each track holds and how far
// each part got. A page that closes mid-take leaves the parts; the next time the project opens, Video Octopus offers to
// finish them. Parts are only removed once the final files exist.
//
// Pause, Restart and Delete (web/recorder.js has the buttons):
// - Pause: the page pauses its recorders, so no chunks come; it says so (/rec-pause) every couple of seconds while
//   paused, which keeps the take "still recording" rather than offered as an unsaved one.
// - Restart: the page drops the take it was recording (/rec-discard) and starts a new one. The dropped take never
//   becomes a take: its folder moves to the studio's trash, marked discarded.
// - Delete take (/rec-delete): nothing is ever deleted. The take's folder, its copies in the project's source/ and
//   their playback copies move to <studio>/.trash/<when>-<take>/ with a manifest.json saying where everything was,
//   and the project goes back to the take it had before. /rec-restore (the Undo) puts it all back. A take that
//   another project also uses, or that its own project has already transcribed, cut or exported, is refused.
import { existsSync, mkdirSync, readdirSync, statSync, openSync, writeSync, closeSync, ftruncateSync, readFileSync, writeFileSync,
  renameSync, rmSync, cpSync } from 'node:fs';
import { spawn, execFile } from 'node:child_process';
import { join, dirname } from 'node:path';
import { settings, saveSettings, readJSON, writeJSON, studioTool, h264, state, setProjectState } from './util.mjs';
import { probeFile, projectDir, projectMeta, formatTemplate, projectsRoot, isTakeFile, proxyName, appendWorklog } from './studio.mjs';
import { recorderSection } from './settings.mjs';

export const FPS = 30;
const TRACKS = ['screen', 'webcam', 'audio'];
const STAMP = /^\d{4}-\d\d-\d\d_\d\d-\d\d-\d\d(-\d+)?$/;
const CHUNK_MAX = 256e6;     // one chunk is about a second; this is only a guard
const STALE_MS = 5000;       // no chunk for this long: the page that recorded it is gone
const finishing = new Set(); // take stamps being saved right now
const saves = new Map();     // take stamp -> { progress, done, ok, error } for the page that pressed Stop

const takeDir = (stamp) => join(settings().recordingsDir, stamp);
// What the record panel starts with (Settings → Recording): { screen, camera, mic, target, countdown }. A format can
// start without the camera ("record": {"camera": false}, e.g. a faceless explainer): its projects start with the screen
// and No camera, and a camera picked in one of them is remembered for that project only (local/state.json), not for
// every project.
const cameraOff = (id) => { const dir = id && projectDir(id); return formatTemplate(dir ? projectMeta(dir)?.type : null)?.record?.camera === false; };
export function recorderChoices(id) {
  const c = recorderSection();
  if (cameraOff(id)) Object.assign(c, { screen: 'screen', camera: state().projects?.[id]?.recCamera || 'none' });
  return c;
}
const takeFile = (stamp) => join(takeDir(stamp), 'take.json');
const readTake = (stamp) => (STAMP.test(stamp || '') ? readJSON(takeFile(stamp), null) : null);
// Paused, disconnected and unfinished recordings also block a restart until saved or dismissed.
// A five-second chunk timeout cannot prove that the creator has finished recording.
export function recorderBusy() {
  if (finishing.size) return true;
  const root = settings().recordingsDir;
  if (!root || !existsSync(root)) return false;
  return readdirSync(root).some((n) => { const t = readTake(n); return t?.recorder === 'browser' && !t.finished && !t.dismissed && !t.discarded; });
}
const saveTake = (stamp, t) => writeJSON(takeFile(stamp), { ...t, updated: Date.now() });
const partName = (stamp, track, t) => `${stamp}_${track}.${t.tracks[track].ext}.part`;

function newStamp() {
  const d = new Date(), two = (n) => String(n).padStart(2, '0');
  const base = `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())}_${two(d.getHours())}-${two(d.getMinutes())}-${two(d.getSeconds())}`;
  let s = base;
  for (let i = 2; existsSync(takeDir(s)); i++) s = `${base}-${i}`;
  return s;
}

// ---- start: the page says what it records; Video Octopus makes the take folder and remembers the choices ----
function startTake(id, b) {
  const kind = ['screen', 'camera', 'mic'].includes(b.kind) ? b.kind : null;
  if (!kind) throw new Error('Nothing to record: pick a screen, a camera or a microphone.');
  const want = kind === 'screen' ? ['screen', ...(b.tracks?.webcam ? ['webcam'] : [])] : kind === 'camera' ? ['webcam'] : ['audio'];
  const tracks = {};
  for (const k of want) {
    const t = b.tracks?.[k] || {};
    if (k === 'audio') tracks.audio = { ext: 'f32le', rate: Math.round(Number(t.rate)) || 48000, channels: Math.min(2, Math.max(1, Math.round(Number(t.channels)) || 1)), next: 0, bytes: 0, pending: [] };
    else tracks[k] = { ext: /mp4/i.test(t.mime || '') ? 'mp4' : 'webm', mime: String(t.mime || '').slice(0, 80), next: 0, bytes: 0, pending: [] };
  }
  // 'block:<id>' records into a block; it isn't remembered as the default.
  const target = b.target === 'layer' ? 'layer' : /^block:[\w-]{1,40}$/.test(b.target || '') ? b.target : 'replace';
  const stamp = newStamp();
  mkdirSync(takeDir(stamp), { recursive: true });
  const str = (v) => String(v ?? '').slice(0, 200);
  saveTake(stamp, {
    recorder: 'browser', project: id, target, kind, started: Date.now(), tracks,
    userAgent: str(b.userAgent), devices: { screen: str(b.devices?.screen), camera: str(b.devices?.camera), mic: str(b.devices?.mic) },
    settings: b.settings && typeof b.settings === 'object' ? JSON.parse(JSON.stringify(b.settings).slice(0, 4000)) : undefined,
  });
  // The panel's choices are remembered for the next take (Settings → Recording shows them); a block's take
  // doesn't change where takes go.
  const c = b.choices;
  if (c) {
    const camera = str(c.camera) || 'none', own = cameraOff(id);
    if (own) setProjectState(id, { recCamera: camera });
    saveSettings({ recorder: { ...recorderSection(),
      screen: c.screen === 'screen' ? 'screen' : 'none', ...(own ? {} : { camera }), mic: str(c.mic) || 'none',
      ...(target.startsWith('block:') ? {} : { target }), countdown: Math.min(10, Math.max(0, Math.round(Number(c.countdown)) || 0)) } });
  }
  return { take: stamp, tracks: Object.keys(tracks) };
}

// ---- chunks: appended in order; one that arrives early waits in its own file until its turn ----
async function rawBody(req) {
  const parts = [];
  let n = 0;
  for await (const c of req) { n += c.length; if (n > CHUNK_MAX) throw new Error('That chunk is too big.'); parts.push(c); }
  return Buffer.concat(parts);
}

function appendTo(path, bytes, buf) {
  const fd = openSync(path, existsSync(path) ? 'r+' : 'w');
  try {
    ftruncateSync(fd, bytes); // a write that got cut off last time (Video Octopus stopped mid-chunk) is written again
    writeSync(fd, buf, 0, buf.length, bytes);
  } finally { closeSync(fd); }
  return bytes + buf.length;
}

async function addChunk(id, url, req) {
  const stamp = url.searchParams.get('take'), track = url.searchParams.get('track'), seq = Number(url.searchParams.get('seq'));
  const t = readTake(stamp);
  if (!t || t.project !== id) throw new Error('Unknown take.');
  if (t.finished || finishing.has(stamp)) throw new Error('That take is already being saved.');
  if (!TRACKS.includes(track) || !t.tracks[track]) throw new Error('Unknown track.');
  if (!Number.isInteger(seq) || seq < 0) throw new Error('Bad chunk number.');
  const buf = await rawBody(req);
  // Read again after the body: the other track's chunk may have been written meanwhile.
  const fresh = readTake(stamp);
  if (!fresh || fresh.finished || fresh.discarded || finishing.has(stamp)) throw new Error('That take is already being saved.');
  const tr = fresh.tracks[track], dir = takeDir(stamp), part = join(dir, partName(stamp, track, fresh));
  if (seq < tr.next || tr.pending.includes(seq)) return { ok: true, next: tr.next, dup: true };
  if (seq > tr.next) {
    writeFileSync(join(dir, `.${partName(stamp, track, fresh)}.${seq}`), buf);
    tr.pending = [...tr.pending, seq].sort((a, b) => a - b);
  } else {
    tr.bytes = appendTo(part, tr.bytes, buf);
    tr.next++;
    drain(dir, part, stamp, track, fresh, tr);
  }
  saveTake(stamp, fresh);
  return { ok: true, next: tr.next };
}

// Early chunks whose turn has come.
function drain(dir, part, stamp, track, t, tr) {
  while (tr.pending.includes(tr.next)) {
    const f = join(dir, `.${partName(stamp, track, t)}.${tr.next}`);
    if (existsSync(f)) tr.bytes = appendTo(part, tr.bytes, readFileSync(f));
    rmSync(f, { force: true });
    tr.pending = tr.pending.filter((s) => s !== tr.next);
    tr.next++;
  }
}

// ---- unsaved takes (the page closed mid-take, or Video Octopus stopped while saving) ----
export function unfinishedTakes(id) {
  const root = settings().recordingsDir;
  let names = [];
  try { names = readdirSync(root).filter((n) => STAMP.test(n)); } catch { return []; }
  const out = [];
  for (const n of names) {
    const t = readTake(n);
    if (!t || t.recorder !== 'browser' || t.finished || t.dismissed || t.discarded || (id && t.project !== id) || finishing.has(n)) continue;
    if (Date.now() - (t.updated || 0) < STALE_MS) continue; // still recording in some page
    const bytes = Object.keys(t.tracks).reduce((s, k) => s + (t.tracks[k].bytes || 0), 0);
    if (!bytes) continue;
    out.push({ take: n, project: t.project, kind: t.kind, target: t.target, started: t.started, updated: t.updated, bytes,
      seconds: Math.max(...Object.values(t.tracks).map((x) => x.next || 0)) });
  }
  return out.sort((a, b) => b.started - a.started);
}

// ---- finish: parts → final take files, then into the project ----
// timing (from the page): { <track>: { start, stop } } in performance.now() ms, the fallback for lining up screen
// and camera when their sound can't (no mic); a recovered take has none.
function finishTake(id, stamp, timing, { recover = false } = {}, ctx) {
  const t = readTake(stamp);
  if (!t || t.project !== id) throw new Error('Unknown take.');
  if (t.finished) throw new Error('That take is already saved.');
  if (t.discarded) throw new Error('That take was discarded.');
  if (finishing.has(stamp)) throw new Error('That take is being saved.');
  if (recover && Date.now() - (t.updated || 0) < STALE_MS) throw new Error('That take is still recording in another window.');
  const dir = takeDir(stamp);
  const tracks = Object.keys(t.tracks).filter((k) => existsSync(join(dir, partName(stamp, k, t))) && t.tracks[k].bytes > 0);
  if (!tracks.length) throw new Error('Nothing was recorded in that take.');
  // Early chunks that never got their turn (a lost chunk): append them in order, so as much as possible survives.
  for (const k of tracks) {
    const tr = t.tracks[k];
    if (!tr.pending.length) continue;
    const part = join(dir, partName(stamp, k, t));
    for (const s of tr.pending) { const f = join(dir, `.${partName(stamp, k, t)}.${s}`); if (existsSync(f)) { tr.bytes = appendTo(part, tr.bytes, readFileSync(f)); rmSync(f, { force: true }); } }
    tr.pending = []; tr.gap = true;
  }
  // Screen and camera start together: the one that started earlier loses its head start (see lineUp).
  const tm = (k) => timing?.[k] && Number.isFinite(timing[k].start) ? timing[k] : null;
  const vids = tracks.filter((k) => k !== 'audio');
  const timed = vids.length > 0 && vids.every(tm);
  const t0 = timed ? Math.max(...vids.map((k) => tm(k).start)) : 0;
  const t1 = timed && vids.every((k) => Number.isFinite(tm(k).stop)) ? Math.min(...vids.map((k) => tm(k).stop)) : null;
  const length = t1 != null ? Math.max(0.1, (t1 - t0) / 1000) : null;
  const byStart = Object.fromEntries(tracks.map((k) => [k, timed && k !== 'audio' ? Math.max(0, (t0 - tm(k).start) / 1000) : 0]));
  finishing.add(stamp);
  const total = length || Math.max(1, ...tracks.map((k) => t.tracks[k].next || 1)); // about a second per chunk
  const jobId = `rec-${stamp}`;
  const label = recover ? 'Saving the unsaved take' : 'Saving take';
  const done = {};
  const emit = (ev) => { saves.set(stamp, { progress: ev.progress, done: Boolean(ev.done), ok: ev.ok, error: ev.ok === false ? ev.label : null }); ctx.emit(ev); };
  emit({ t: 'job', id: jobId, label: `${label}…`, progress: 0 });
  const progress = () => emit({ t: 'job', id: jobId, label: `${label}…`, progress: Math.min(0.99, tracks.reduce((s, k) => s + (done[k] || 0), 0) / tracks.length) });
  lineUp(dir, stamp, t, vids, byStart)
    .then(({ offsets, align }) => {
      saveTake(stamp, { ...t, timing: timing || null, offsets, align, length, recovered: recover || undefined });
      return Promise.all(tracks.map((k) => convert(dir, stamp, k, t, offsets[k] || 0, total, (p) => { done[k] = p; progress(); })));
    })
    .then(async (files) => {
      await evenEnds(dir, files.filter((f) => !f.endsWith('.wav')));
      const durations = Object.fromEntries(files.map((f) => [f, probeFile(join(dir, f))?.duration || 0]));
      const fresh = readTake(stamp);
      saveTake(stamp, { ...fresh, finished: Date.now(), files, durations });
      // The final files exist: now the parts can go.
      for (const k of tracks) rmSync(join(dir, partName(stamp, k, t)), { force: true });
      finishing.delete(stamp);
      emit({ t: 'job', id: jobId, label: 'Take saved', progress: 1, done: true, ok: true });
      const secs = Math.min(...Object.values(durations).filter(Boolean));
      ctx.receiveTake(id, dir, fresh.target, Number.isFinite(secs) ? secs : undefined);
      return files;
    })
    .catch((e) => {
      finishing.delete(stamp);
      console.error(`Saving take ${stamp} failed: ${e.message}`);
      emit({ t: 'job', id: jobId, label: `Couldn't save the take: ${e.message}. Its parts are kept in ${dir}`, progress: 1, done: true, ok: false });
    });
  return { ok: true, take: stamp, tracks };
}

// How far ahead each video part starts, in seconds. A recorder's file starts at its first video frame, which comes
// a little after its start (up to a frame), so the starts the page reports are only a fallback: both parts carry
// the same mic, so the lag between their sound says it to the millisecond.
async function lineUp(dir, stamp, t, vids, byStart) {
  if (vids.length === 2) {
    const [a, b] = vids;
    const lag = await audioLag(join(dir, partName(stamp, a, t)), join(dir, partName(stamp, b, t))).catch(() => null);
    if (lag != null) return { offsets: { [a]: Math.max(0, -lag), [b]: Math.max(0, lag) }, align: { by: 'sound', lagMs: Math.round(lag * 10000) / 10 } };
  }
  return { offsets: byStart, align: { by: vids.length === 2 ? 'start' : 'none' } };
}

// The first 30 s of a part's sound as mono 8 kHz floats, on the part's own timeline (silence before the sound starts).
function sound8k(part) {
  return new Promise((ok, fail) => {
    const ff = spawn(studioTool('ffmpeg'), ['-v', 'error', '-nostdin', '-i', part, '-map', '0:a:0', '-af', 'aresample=async=1:first_pts=0', '-ac', '1', '-ar', '8000', '-t', '30', '-f', 'f32le', 'pipe:1']);
    const bufs = [];
    ff.stdout.on('data', (d) => bufs.push(d));
    ff.on('error', fail);
    ff.on('exit', () => { const b = Buffer.concat(bufs); ok(new Float32Array(b.buffer, b.byteOffset, Math.floor(b.length / 4))); });
  });
}

// Seconds by which part B's sound runs behind part A's (positive: B has the longer head start), or null when the
// sound can't tell (no mic, digital silence). Envelopes at 1 kHz first (±0.4 s), then the samples around the best lag.
async function audioLag(fa, fb) {
  const [a, b] = await Promise.all([sound8k(fa), sound8k(fb)]);
  if (a.length < 8000 || b.length < 8000) return null;
  const env = (x) => { const e = new Float32Array(Math.floor(x.length / 8)); for (let i = 0; i < e.length; i++) { let s = 0; for (let j = 0; j < 8; j++) s += Math.abs(x[i * 8 + j]); e[i] = s / 8; } return e; };
  // Pearson correlation of x[i] with y[i + lag] over the overlap.
  const corr = (x, y, lag) => {
    const i0 = Math.max(0, -lag), i1 = Math.min(x.length, y.length - lag);
    const n = i1 - i0;
    if (n < 500) return -1;
    let sx = 0, sy = 0, sxx = 0, syy = 0, sxy = 0;
    for (let i = i0; i < i1; i++) { const u = x[i], v = y[i + lag]; sx += u; sy += v; sxx += u * u; syy += v * v; sxy += u * v; }
    const vx = sxx - (sx * sx) / n, vy = syy - (sy * sy) / n;
    return vx > 1e-9 && vy > 1e-9 ? (sxy - (sx * sy) / n) / Math.sqrt(vx * vy) : -1;
  };
  const ea = env(a), eb = env(b);
  let best = 0, r = -1;
  for (let lag = -400; lag <= 400; lag++) { const c = corr(ea, eb, lag); if (c > r) { r = c; best = lag; } }
  if (r < 0.5) return null;
  let fine = best * 8, rf = -1;
  for (let lag = best * 8 - 12; lag <= best * 8 + 12; lag++) { const c = corr(a, b, lag); if (c > rf) { rf = c; fine = lag; } }
  return (rf > 0.3 ? fine : best * 8) / 8000;
}

// One track with ffmpeg into a hidden temp file, renamed when complete. Video: constant 30 fps H.264 (the Mac's
// encoder or libx264, see h264()) with AAC; the mic-only track: 24-bit PCM WAV, no lossy step. The screen keeps its
// own resolution, at 16 Mbps for 1080p and more for bigger screens (a 4K or Retina screen: 40), the camera 10 Mbps.
const screenRate = (t) => {
  const s = t.settings?.screen || {}, px = (Number(s.width) || 1920) * (Number(s.height) || 1080);
  return `${Math.round(Math.min(40, Math.max(16, (16 * px) / (1920 * 1080))))}M`;
};
function convert(dir, stamp, track, t, offset, total, onProgress) {
  const tr = t.tracks[track];
  const part = join(dir, partName(stamp, track, t));
  const name = track === 'audio' ? `${stamp}_audio.wav` : `${stamp}_${track}.mp4`;
  const tmp = join(dir, `.${name}.tmp`);
  const trim = offset > 0.0005 ? ['-ss', offset.toFixed(4)] : [];
  const args = track === 'audio'
    ? ['-f', 'f32le', '-ar', String(tr.rate), '-ac', String(tr.channels), '-i', part, ...trim, '-c:a', 'pcm_s24le', '-rf64', 'auto', '-f', 'wav', tmp]
    : ['-fflags', '+genpts', '-i', part, ...trim, '-map', '0:v:0', '-map', '0:a:0?',
      '-vf', 'scale=trunc(iw/2)*2:trunc(ih/2)*2:out_range=tv,format=yuv420p', '-color_range', 'tv', '-fps_mode', 'cfr', '-r', String(FPS),
      ...h264(track === 'screen' ? screenRate(t) : '10M'), '-c:a', 'aac', '-b:a', '256k', '-ar', '48000', '-movflags', '+faststart', '-f', 'mp4', tmp];
  return ffmpeg(args, (secs) => onProgress(Math.min(1, secs / total))).then(() => {
    if (!existsSync(tmp) || !statSync(tmp).size) throw new Error('ffmpeg wrote nothing');
    renameSync(tmp, join(dir, name));
    onProgress(1);
    return name;
  }, (e) => { rmSync(tmp, { force: true }); throw e; });
}

function ffmpeg(args, onTime) {
  return new Promise((ok, fail) => {
    const ff = spawn(studioTool('ffmpeg'), ['-y', '-v', 'error', '-nostdin', '-progress', 'pipe:1', ...args]);
    let err = '';
    ff.stderr.on('data', (d) => { err = (err + d).slice(-2000); });
    ff.stdout.on('data', (d) => { const m = /out_time_us=(\d+)/.exec(String(d)); if (m && onTime) onTime(Number(m[1]) / 1e6); });
    ff.on('error', (e) => fail(new Error(`ffmpeg didn't start (${e.message})`)));
    ff.on('exit', (code) => (code === 0 ? ok() : fail(new Error(`ffmpeg ${code}: ${err.trim().split('\n').pop() || 'no output'}`))));
  });
}

// Screen and camera end together: the one with more frames is cut (stream copy) to the other's frame count.
async function evenEnds(dir, files) {
  if (files.length < 2) return;
  const d = await Promise.all(files.map((f) => videoLength(join(dir, f))));
  const min = Math.min(...d);
  for (const [i, f] of files.entries()) {
    if (!min || d[i] - min < 0.5 / FPS) continue;
    const tmp = join(dir, `.${f}.even.tmp`);
    try {
      await ffmpeg(['-i', join(dir, f), '-t', min.toFixed(4), '-map', '0', '-c', 'copy', '-movflags', '+faststart', '-f', 'mp4', tmp]);
      renameSync(tmp, join(dir, f));
    } catch { rmSync(tmp, { force: true }); } // the files stay as they are, a frame apart
  }
}
const videoLength = (p) => new Promise((ok) => execFile(studioTool('ffprobe'), ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=duration', '-of', 'csv=p=0', p],
  { timeout: 15000 }, (e, out) => ok(e ? 0 : parseFloat(String(out)) || 0)));

// ---- pause: the page's recorders are paused; it says so every couple of seconds (so the take isn't stale) ----
function pauseTake(id, stamp, paused) {
  const t = readTake(stamp);
  if (!t || t.project !== id) throw new Error('Unknown take.');
  if (t.finished || t.discarded || finishing.has(stamp)) throw new Error('That take is already being saved.');
  const pauses = Array.isArray(t.pauses) ? t.pauses.slice(-200) : [];
  const open = pauses.length && pauses[pauses.length - 1].resumed == null;
  if (paused && !open) pauses.push({ at: Date.now(), resumed: null });
  if (!paused && open) pauses[pauses.length - 1].resumed = Date.now();
  saveTake(stamp, { ...t, paused: Boolean(paused), pauses });
  return { ok: true, paused: Boolean(paused) };
}

// ---- the studio's trash: takes are moved here, never deleted ----
// <studio>/.trash/<when>-<take>/ holds take/ (the recordings folder), project/source/ and project/work/ (the project's
// copies and playback copies) and manifest.json. Before there's a studio: next to the recordings folder.
export function trashRoot() {
  const s = settings();
  return s.studio ? join(s.studio, '.trash') : join(dirname(s.recordingsDir), '.video-octopus-trash');
}
export const TRASH_NAME = /^\d{4}-\d\d-\d\d_\d\d-\d\d-\d\d(-\d+)?-[\w .()-]{1,120}$/;
// A take folder's name: the recorder's stamp, or a folder another recorder made (no slashes, no dot files).
const takeName = (n) => typeof n === 'string' && /^[\w .()-]{1,120}$/.test(n) && !n.startsWith('.') && !n.includes('..');

// rename, or across disks a copy that is complete before the original goes. (The editor's Media section, server/media.mjs,
// moves a project's files to the same trash with these.)
export function moveAside(from, to) {
  mkdirSync(dirname(to), { recursive: true });
  if (existsSync(to)) throw new Error(`${to} is already there.`);
  try { renameSync(from, to); }
  catch (e) {
    if (e.code !== 'EXDEV') throw e;
    cpSync(from, to, { recursive: true, errorOnExist: true, force: false, preserveTimestamps: true });
    rmSync(from, { recursive: true, force: true });
  }
}

export function newTrashEntry(stamp) {
  const d = new Date(), two = (n) => String(n).padStart(2, '0');
  const when = `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())}_${two(d.getHours())}-${two(d.getMinutes())}-${two(d.getSeconds())}`;
  let name = `${when}-${stamp}`;
  for (let i = 2; existsSync(join(trashRoot(), name)); i++) name = `${when}-${i}-${stamp}`;
  mkdirSync(join(trashRoot(), name), { recursive: true });
  return name;
}

// Restart: the take being recorded is dropped. It never becomes a take (or an unsaved one): marked discarded and
// moved to the trash.
function discardTake(id, stamp) {
  const t = readTake(stamp);
  if (!t || t.project !== id) throw new Error('Unknown take.');
  if (t.finished || finishing.has(stamp)) throw new Error('That take is already being saved.');
  saveTake(stamp, { ...t, discarded: Date.now() });
  const entry = newTrashEntry(stamp);
  moveAside(takeDir(stamp), join(trashRoot(), entry, 'take'));
  writeJSON(join(trashRoot(), entry, 'manifest.json'), { v: 1, kind: 'discarded', take: stamp, at: Date.now(), project: id, from: takeDir(stamp) });
  return { ok: true, trash: entry };
}

// The projects whose source/ holds this take's files (or whose project.json lists it), and what was made from it.
function projectsUsing(stamp) {
  const out = [];
  let names = [];
  try { names = readdirSync(projectsRoot()); } catch { return out; }
  for (const n of names) {
    if (n.startsWith('.') || n.startsWith('_')) continue;
    const dir = join(projectsRoot(), n);
    let files = [];
    try { files = readdirSync(join(dir, 'source')).filter((f) => f.startsWith(`${stamp}_`) && isTakeFile(f)); } catch {}
    const meta = projectMeta(dir);
    if (files.length || meta?.takes?.includes(stamp)) out.push({ id: n, dir, name: meta?.name || n, files, meta: meta || {} });
  }
  return out;
}

// Work the creator did on this take in its project after it arrived: a transcript, a cut or an export. (A transcript
// the take brought along is copied as it arrives, so the first minute doesn't count.)
const WORK_FILES = ['work/tr/words.json', 'work/words.json', 'work/edl_manual.json'];
function workOnTake(u, arrived) {
  const after = (p) => { try { return statSync(p).mtimeMs > arrived + 60000; } catch { return false; } };
  if (WORK_FILES.slice(0, 2).some((f) => after(join(u.dir, f)))) return 'transcribed';
  if (after(join(u.dir, WORK_FILES[2]))) return 'cut';
  try { if (readdirSync(join(u.dir, 'renders')).some((f) => !f.startsWith('.') && after(join(u.dir, 'renders', f)))) return 'exported'; } catch {}
  return null;
}

const refuse = (message) => Object.assign(new Error(message), { status: 409 });

// Delete take: everything moves to the trash, and the project goes back to the take it had before (an Undo puts it
// all back). Refused while the take is recording or saving, when another project uses it too, and when its project
// already has work made from it.
export function deleteTake(id, stamp) {
  if (!takeName(stamp)) throw new Error('Unknown take.');
  const dir = takeDir(stamp);
  if (!existsSync(dir) || !statSync(dir).isDirectory()) throw new Error('That take isn’t in the recordings folder any more.');
  const t = readTake(stamp);
  if (finishing.has(stamp) || (t?.recorder === 'browser' && !t.finished && !t.dismissed)) throw refuse('That take is still recording or saving.');
  const users = projectsUsing(stamp);
  const mine = users.find((u) => u.id === id);
  if (!mine && t?.project !== id) throw new Error('That take isn’t part of this project.');
  const others = users.filter((u) => u.id !== id);
  if (others.length) throw refuse(`This take is also used by ${others.map((u) => `“${u.name}”`).join(', ')}, so it wasn’t deleted. Remove it there first.`);
  let arrived = t?.finished || 0;
  if (mine) for (const f of mine.files) { try { arrived = Math.max(arrived, statSync(join(mine.dir, 'source', f)).mtimeMs); } catch {} }
  const work = mine && mine.meta.activeTake === stamp ? workOnTake(mine, arrived) : null;
  if (work) throw refuse(`This take is already ${work} in “${mine.name}”, so it wasn’t deleted. Record a new take to replace it.`);

  const entry = newTrashEntry(stamp), root = join(trashRoot(), entry);
  const manifest = { v: 1, kind: 'deleted', take: stamp, at: Date.now(), from: dir, project: mine ? id : null, projectName: mine?.name || null, files: [], proxies: [] };
  if (mine) {
    const meta = mine.meta, pdir = mine.dir;
    for (const f of mine.files) {
      moveAside(join(pdir, 'source', f), join(root, 'project', 'source', f));
      manifest.files.push(f);
      const px = proxyName(f);
      if (existsSync(join(pdir, px))) { moveAside(join(pdir, px), join(root, 'project', px)); manifest.proxies.push(px); }
    }
    // project.json: no longer one of its takes; the canvas goes back to the take before it; its layers go.
    const takes = (meta.takes || []).filter((x) => x !== stamp);
    const next = { ...meta, takes };
    const wasActive = meta.activeTake === stamp;
    if (wasActive) {
      delete next.activeTake; delete next.activeSince;
      if (takes.length) Object.assign(next, { activeTake: takes[takes.length - 1], activeSince: Date.now() });
    }
    const layers = meta.layout?.layers;
    const ours = (x) => typeof x?.file === 'string' && x.file.replace(/^source\//, '').startsWith(`${stamp}_`);
    if (Array.isArray(layers) && layers.some(ours)) next.layout = { ...meta.layout, layers: layers.filter((x) => !ours(x)) };
    manifest.before = { takes: meta.takes || [], activeTake: meta.activeTake ?? null, activeSince: meta.activeSince ?? null, layers: Array.isArray(layers) ? layers.filter(ours) : [] };
    manifest.after = { activeTake: next.activeTake ?? null, activeSince: next.activeSince ?? null };
    // A block whose own file was this take waits for a recording again.
    const bpath = join(pdir, 'work', 'blocks.json'), doc = readJSON(bpath, null);
    const blk = doc?.blocks?.find((b) => typeof b?.source?.file === 'string' && b.source.file.replace(/^source\//, '').startsWith(`${stamp}_`));
    if (blk) {
      manifest.block = { id: blk.id, source: blk.source };
      blk.source = { pending: 'record' };
      writeJSON(bpath, doc);
    }
    writeJSON(join(pdir, 'project.json'), next);
    appendWorklog(pdir, `Deleted take ${stamp}: moved to the studio's trash (${entry})${wasActive ? next.activeTake ? `; the canvas take is ${next.activeTake} again` : '; the project has no take now' : ''}`);
  }
  moveAside(dir, join(root, 'take'));
  writeJSON(join(root, 'manifest.json'), manifest);
  return { ok: true, take: stamp, trash: entry, project: manifest.project, projectName: manifest.projectName, activeTake: manifest.after?.activeTake ?? null };
}

// Undo: the take's folder, its project files and the project's choices come back (the canvas only goes back to it if
// nobody picked another take meanwhile).
export function restoreTake(id, entry) {
  if (!TRASH_NAME.test(entry || '')) throw new Error('Unknown trash entry.');
  const root = join(trashRoot(), entry), m = readJSON(join(root, 'manifest.json'), null);
  if (!m || m.kind !== 'deleted' || !takeName(m.take)) throw new Error('That isn’t a deleted take.');
  if (m.project && m.project !== id) throw new Error('That take belongs to another project.');
  if (!m.project && !existsSync(join(root, 'take'))) throw new Error('That take isn’t in the trash any more.');
  const dir = takeDir(m.take);
  if (existsSync(dir)) throw refuse('A take with that name is back in the recordings folder already.');
  const pdir = m.project ? projectDir(m.project) : null;
  if (m.project && !pdir) throw new Error('The project that take was in is gone; the take stays in the trash.');
  if (pdir) for (const f of m.files) if (existsSync(join(pdir, 'source', f))) throw refuse(`source/${f} is in the project again already.`);
  moveAside(join(root, 'take'), dir);
  if (pdir) {
    for (const f of m.files) moveAside(join(root, 'project', 'source', f), join(pdir, 'source', f));
    for (const px of m.proxies || []) if (!existsSync(join(pdir, px))) moveAside(join(root, 'project', px), join(pdir, px));
    const meta = projectMeta(pdir) || {}, b = m.before || {};
    const takes = (meta.takes || []).filter((x) => x !== m.take);
    takes.splice(Math.min(takes.length, Math.max(0, (b.takes || []).indexOf(m.take))), 0, m.take);
    const next = { ...meta, takes };
    // Nobody changed the canvas take since the delete: it goes back to what it was.
    if ((meta.activeTake ?? null) === (m.after?.activeTake ?? null)) {
      delete next.activeTake; delete next.activeSince;
      if (b.activeTake) next.activeTake = b.activeTake;
      if (b.activeSince) next.activeSince = b.activeSince;
    }
    if (b.layers?.length) {
      const have = new Set((meta.layout?.layers || []).map((x) => x.file));
      next.layout = { ...(meta.layout || {}), layers: [...(meta.layout?.layers || []), ...b.layers.filter((x) => !have.has(x.file))] };
    }
    if (m.block) {
      const bpath = join(pdir, 'work', 'blocks.json'), doc = readJSON(bpath, null);
      const blk = doc?.blocks?.find((x) => x.id === m.block.id);
      if (blk && blk.source?.pending) { blk.source = m.block.source; writeJSON(bpath, doc); }
    }
    writeJSON(join(pdir, 'project.json'), next);
    appendWorklog(pdir, `Brought back take ${m.take} from the studio's trash`);
  }
  // The entry is empty now but for its manifest: it goes.
  const left = (d) => readdirSync(d, { withFileTypes: true }).some((e) => (e.isDirectory() ? left(join(d, e.name)) : e.name !== 'manifest.json' || d !== root));
  if (!left(root)) rmSync(root, { recursive: true, force: true });
  return { ok: true, take: m.take, project: m.project };
}

// ---- routes: /rec-start, /rec-chunk, /rec-pause, /rec-discard, /rec-finish, /rec-status, /rec-unfinished, /rec-dismiss,
// /rec-delete, /rec-restore. Returns true when it answered. ----
export async function recRoute(req, res, { id, action, url, send, body, emit, receiveTake }) {
  if (!action.startsWith('/rec-')) return false;
  try {
    if (action === '/rec-unfinished' && req.method === 'GET') return send(res, 200, { takes: unfinishedTakes(id) }), true;
    // How the save after Stop is going (the page polls it, so it needs no event stream).
    if (action === '/rec-status' && req.method === 'GET') {
      const stamp = url.searchParams.get('take'), t = readTake(stamp);
      if (!t || t.project !== id) throw new Error('Unknown take.');
      if (saves.has(stamp)) return send(res, 200, saves.get(stamp)), true;
      // No save running here (Video Octopus restarted meanwhile): finished, or offered again as an unsaved take.
      return send(res, 200, t.finished ? { progress: 1, done: true, ok: true }
        : { progress: 0, done: true, ok: false, error: 'Saving the take stopped (Video Octopus restarted). Open the project to finish it: it shows as an unsaved take.' }), true;
    }
    if (req.method !== 'POST') return send(res, 405, { error: 'POST only' }), true;
    if (action === '/rec-chunk') return send(res, 200, await addChunk(id, url, req)), true;
    const b = await body(req);
    if (action === '/rec-start') return send(res, 200, startTake(id, b)), true;
    if (action === '/rec-finish') {
      return send(res, 200, finishTake(id, String(b.take || ''), b.timing || null, { recover: Boolean(b.recover) }, { emit, receiveTake })), true;
    }
    if (action === '/rec-dismiss') {
      const t = readTake(String(b.take || ''));
      if (!t || t.project !== id) throw new Error('Unknown take.');
      saveTake(b.take, { ...t, dismissed: Date.now() }); // the parts stay in the take folder
      return send(res, 200, { ok: true }), true;
    }
    if (action === '/rec-pause') return send(res, 200, pauseTake(id, String(b.take || ''), Boolean(b.paused))), true;
    if (action === '/rec-discard') return send(res, 200, discardTake(id, String(b.take || ''))), true;
    if (action === '/rec-delete') {
      const r = deleteTake(id, String(b.take || ''));
      emit({ t: 'files' });
      return send(res, 200, r), true;
    }
    if (action === '/rec-restore') {
      const r = restoreTake(id, String(b.trash || ''));
      emit({ t: 'files' });
      return send(res, 200, r), true;
    }
  } catch (e) { return send(res, e.status || 400, { error: e.message }), true; }
  return send(res, 404, { error: 'Unknown action' }), true;
}
