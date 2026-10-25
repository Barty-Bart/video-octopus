// Playback: what the editor plays for each source file, and the 720p "editing copies" (work/proxy_<file>.mp4).
//
// Two modes (Settings › Storage › Playback, and per video in the Media section: project.json "playback"):
// - originals (Keep originals, the default): the canvas, the Cut Editor and the timeline play the files in source/.
//   A file the browser can play but can't seek well (a fragmented MP4 like MediaRecorder writes, an MP4 / MOV with
//   its index at the end, a WebM without Cues) is remuxed in place once: stream copy, no re-encode, +faststart, into
//   a hidden temp file next to it that replaces it only when it's whole and checked. A file the browser can't play
//   at all (HEVC, ProRes, PCM sound in a .mov, 10-bit H.264…) gets a 720p copy, and the page says why.
// - optimise (Optimise for editing): every video gets the 720p H.264 + AAC copy, for smooth scrubbing. Until it's
//   made, the editor plays the original (indexed first when it needs it): nothing waits for the copy.
// Export always reads the originals in source/ (server/export*.mjs); a copy is never exported.
//
// The copies are re-creatable caches: after an export the editor offers to delete them (they go for good, not to
// the Bin), and Settings › Storage lists them with Delete all copies. A video whose copies were deleted
// (project.json copiesDeleted) gets them again only when Optimise is on and the video is edited again.
import { existsSync, statSync, openSync, readSync, closeSync, renameSync, rmSync, utimesSync, readdirSync, mkdirSync } from 'node:fs';
import { spawn, execFileSync } from 'node:child_process';
import { join, extname, basename } from 'node:path';
import { settings, studioTool, h264 } from './util.mjs';
// (read at call time only: studio.mjs re-exports makeProxies and proxyRunning from this module)
import { projectMeta, saveProjectMeta, proxyName, sources, isAudio, projectsRoot } from './studio.mjs';

export const PLAYBACK_MODES = ['originals', 'optimise'];
// The default, measured (handoff RESULTS): on a Mac the recorder's files (VideoToolbox H.264, a keyframe every 12
// frames) seek in about 17 ms at 1440p in Chromium and scrub at about 59 frames a second, smooth enough to edit as
// they are. Elsewhere the recorder uses libx264's default of a keyframe every 250 frames (8.3 s): a 1440p original
// seeks in about 95 ms and scrubs at 3 to 5 frames a second, so Windows and Linux start with the copy (made with a
// keyframe every 15 frames: 60 frames a second).
export const DEFAULT_PLAYBACK = process.platform === 'darwin' ? 'originals' : 'optimise';

// The mode for a video: its own choice, else Settings › Storage › Playback, else the default.
export const settingsMode = () => { const s = settings().storage?.playback; return PLAYBACK_MODES.includes(s) ? s : DEFAULT_PLAYBACK; };
export function playbackMode(dir) {
  const own = projectMeta(dir)?.playback;
  return PLAYBACK_MODES.includes(own) ? own : settingsMode();
}

// ---- is a file's index where the browser can use it? ----
// 'ok', 'fragmented' (moof boxes: MediaRecorder's MP4), 'moov-at-end' (no +faststart), 'no-cues' (a WebM / MKV
// without Cues: MediaRecorder's WebM), 'incomplete' (an MP4 still being written: no moov yet) or 'unknown' (not an
// MP4 inside, whatever its name says).
function readAt(fd, size, off, n) {
  const b = Buffer.alloc(Math.max(0, Math.min(n, size - off)));
  const got = b.length ? readSync(fd, b, 0, b.length, off) : 0;
  return b.subarray(0, got);
}
const BOXES = new Set(['ftyp', 'styp', 'wide', 'free', 'skip', 'mdat', 'moov', 'moof', 'pnot', 'uuid']);
export function mp4Index(p) {
  let fd = null;
  try {
    const size = statSync(p).size;
    fd = openSync(p, 'r');
    let moov = -1, mdat = -1;
    for (let off = 0, i = 0; i < 200 && off + 8 <= size; i++) {
      const b = readAt(fd, size, off, 16);
      if (b.length < 8) break;
      const type = b.toString('latin1', 4, 8);
      if (i === 0 && !BOXES.has(type)) return 'unknown'; // not an MP4 / MOV at all: ffprobe says what it is
      if (type === 'moof') return 'fragmented';
      if (type === 'moov' && moov < 0) moov = i;
      if (type === 'mdat' && mdat < 0) mdat = i;
      let n = b.readUInt32BE(0);
      if (n === 1) { if (b.length < 16) break; n = Number(b.readBigUInt64BE(8)); }
      if (n === 0) break; // the box runs to the end (ffmpeg's mdat while it writes)
      if (n < 8 || off + n > size) return 'incomplete'; // a box past the end: cut short, or still being written
      off += n;
    }
    if (moov < 0) return 'incomplete';
    return mdat >= 0 && mdat < moov ? 'moov-at-end' : 'ok';
  } catch { return 'incomplete'; } finally { if (fd != null) try { closeSync(fd); } catch {} }
}
// An EBML number at b[off]: its length in bytes and value (marker kept for IDs); unknown = all ones (a live stream's size).
function vint(b, off, id = false) {
  const first = b[off];
  if (first === undefined || first === 0) return null;
  let len = 1;
  while (len <= 8 && !(first & (0x80 >> (len - 1)))) len++;
  if (len > 8 || off + len > b.length) return null;
  let v = id ? first : first & (0xff >> len), ones = (first & (0xff >> len)) === (0xff >> len);
  for (let i = 1; i < len; i++) { v = v * 256 + b[off + i]; if (b[off + i] !== 0xff) ones = false; }
  return { len, value: v, unknown: !id && ones };
}
const CUES = Buffer.from([0x1c, 0x53, 0xbb, 0x6b]);
export function mkvIndex(p) {
  let fd = null;
  try {
    const size = statSync(p).size;
    fd = openSync(p, 'r');
    const b = readAt(fd, size, 0, 1 << 20);
    let off = 0;
    const el = () => {
      const id = vint(b, off, true); if (!id) return null;
      const sz = vint(b, off + id.len); if (!sz) return null;
      const at = off + id.len + sz.len;
      return { id: id.value, size: sz.unknown ? null : sz.value, at };
    };
    const head = el();
    if (!head || head.id !== 0x1a45dfa3 || head.size == null) return 'no-cues';
    off = head.at + head.size;
    const seg = el();
    if (!seg || seg.id !== 0x18538067) return 'no-cues';
    off = seg.at;
    while (off < b.length) {
      const e = el();
      if (!e) break;
      if (e.id === 0x1c53bb6b) return 'ok'; // Cues
      if (e.id === 0x114d9b74 && e.size != null && b.subarray(e.at, e.at + e.size).indexOf(CUES) >= 0) return 'ok'; // a SeekHead naming the Cues
      if (e.id === 0x1f43b675 || e.size == null) break; // the first Cluster (or a live element): no index before it
      off = e.at + e.size;
    }
    return 'no-cues';
  } catch { return 'no-cues'; } finally { if (fd != null) try { closeSync(fd); } catch {} }
}

// ---- can the browser (Chromium) play it? ----
const FAMILY = { '.mp4': 'mp4', '.m4v': 'mp4', '.mov': 'mp4', '.webm': 'mkv', '.mkv': 'mkv' };
const V_OK = { mp4: ['h264', 'vp9', 'av1'], mkv: ['vp8', 'vp9', 'av1'] };
const A_OK = { mp4: ['aac', 'mp3', 'opus', 'flac'], mkv: ['opus', 'vorbis'] };
const NAMES = { hevc: 'HEVC (H.265)', prores: 'ProRes', h264: 'H.264', mpeg4: 'MPEG-4', mjpeg: 'Motion JPEG', dnxhd: 'DNxHD', alac: 'Apple Lossless', ac3: 'AC-3', eac3: 'E-AC-3' };
const codecName = (c) => (/^pcm_/.test(c) ? 'PCM' : NAMES[c] || String(c).toUpperCase());
const infos = new Map();
const ffprobe = () => studioTool('ffprobe');

// { ok: true | false | null (unknown: ffprobe couldn't read it), why, index, family }
export function playInfo(p) {
  let st;
  try { st = statSync(p); } catch { return null; }
  const key = `${p}|${st.mtimeMs}|${st.size}`;
  if (infos.has(key)) return infos.get(key);
  const family = FAMILY[extname(p).toLowerCase()] || null;
  const index = family === 'mp4' ? mp4Index(p) : family === 'mkv' ? mkvIndex(p) : 'ok';
  if (index === 'incomplete') return { ok: null, why: 'it is still being written', index, family }; // not cached: look again
  let streams = null;
  try {
    streams = JSON.parse(String(execFileSync(ffprobe(), ['-v', 'error', '-show_entries', 'stream=codec_type,codec_name,pix_fmt', '-of', 'json', p],
      { timeout: 20000, stdio: ['ignore', 'pipe', 'pipe'] }))).streams || [];
  } catch { streams = null; }
  let info;
  if (!streams || !family) info = { ok: null, why: family ? 'its format could not be read' : 'its format is not one the browser plays', index, family };
  else {
    const v = streams.find((s) => s.codec_type === 'video'), a = streams.find((s) => s.codec_type === 'audio');
    let why = null;
    if (!v) why = 'it has no picture';
    else if (!V_OK[family].includes(v.codec_name)) why = `its picture is ${codecName(v.codec_name)}`;
    else if (v.codec_name === 'h264' && !['yuv420p', 'yuvj420p'].includes(v.pix_fmt)) why = `its picture is H.264 in ${v.pix_fmt}`;
    else if (a && !A_OK[family].includes(a.codec_name)) why = `its sound is ${codecName(a.codec_name)}`;
    const gop = why ? null : keyframeGap(p);
    info = { ok: !why, why, index, family, video: v?.codec_name || null, audio: a?.codec_name || null, gop, slowSeek: gop != null && gop > SLOW_GOP };
  }
  infos.set(key, info);
  while (infos.size > 200) infos.delete(infos.keys().next().value);
  return info;
}

// The longest gap between keyframes in the first 30 s, in seconds (null: unknown). A browser seek decodes from the
// keyframe before the spot, so a long gap is a slow seek however the file is indexed.
export const SLOW_GOP = 2;
export function keyframeGap(p) {
  try {
    const out = String(execFileSync(ffprobe(), ['-v', 'error', '-select_streams', 'v:0', '-read_intervals', '%+30', '-show_entries', 'packet=pts_time,flags', '-of', 'csv=p=0', p],
      { timeout: 20000, stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 16e6 }));
    const lines = out.split(/\r?\n/).filter(Boolean).map((l) => l.split(','));
    const keys = lines.filter((x) => /K/.test(x[1] || '')).map((x) => Number(x[0])).filter(Number.isFinite).sort((a, b) => a - b);
    const last = Math.max(...lines.map((x) => Number(x[0])).filter(Number.isFinite));
    if (!keys.length || !Number.isFinite(last)) return null;
    let gap = last - keys[keys.length - 1];
    for (let i = 1; i < keys.length; i++) gap = Math.max(gap, keys[i] - keys[i - 1]);
    return Math.round(gap * 100) / 100;
  } catch { return null; }
}

const token = (p) => { try { const s = statSync(p); return `${s.size}-${Math.round(s.mtimeMs)}`; } catch { return ''; } };

// What the editor plays for a source file: { src (a path in the project), using: 'copy' | 'original' | null, v (changes
// when the file does: the page reloads it), why (when nothing plays yet) }. Never waits: a copy is used once it exists.
export function playSource(dir, f) {
  const orig = `source/${f}`;
  if (isAudio(f)) return { src: orig, using: 'original', v: token(join(dir, orig)) };
  const copy = proxyName(f), hasCopy = existsSync(join(dir, copy));
  const info = playInfo(join(dir, orig));
  const plays = info?.ok === true;
  if (hasCopy && (playbackMode(dir) === 'optimise' || !plays)) return { src: copy, using: 'copy', v: token(join(dir, copy)) };
  if (plays) return { src: orig, using: 'original', v: token(join(dir, orig)) };
  // Not known (ffprobe couldn't say): the browser tries the original; a copy is made meanwhile. A file still being
  // written, or one known not to play, waits for its copy.
  if (info && info.ok === null && info.index !== 'incomplete') return { src: orig, using: 'original', v: token(join(dir, orig)), unsure: true };
  return { src: null, using: null, v: '', why: info?.why || 'it could not be read' };
}

// ---- background jobs: index (remux in place) and copy, one chain per source file ----
const running = new Map(); // <dir>/source/<file> -> { kind, proc }
const jobKey = (dir, f) => join(dir, 'source', f);
// A playback job (index or copy) is running for one of these source files right now: the file mustn't move meanwhile.
export const proxyRunning = (dir, files) => files.some((f) => running.has(jobKey(dir, f)));
export const playbackJobs = (dir) => sources(dir).filter((f) => running.has(jobKey(dir, f))).map((f) => ({ file: f, kind: running.get(jobKey(dir, f)).kind }));

function ffmpegJob(key, kind, args, total, onTime) {
  return new Promise((done) => {
    const ff = spawn(studioTool('ffmpeg'), args);
    const cur = running.get(key);
    if (cur) Object.assign(cur, { kind, proc: ff });
    let err = '';
    ff.stderr?.on('data', (d) => { err = (err + d).slice(-1500); });
    ff.stdout.on('data', (d) => {
      const m = /out_time_(?:us|ms)=(\d+)/.exec(String(d));
      if (m && total) onTime(Math.min(1, Number(m[1]) / 1e6 / total));
    });
    // ffmpeg missing (or not where Settings says): the job says so; the server stays up.
    ff.on('error', (e) => done({ ok: false, error: e.code === 'ENOENT' ? 'ENOENT' : e.message }));
    ff.on('exit', (code) => done(code === 0 ? { ok: true } : { ok: false, error: `ffmpeg ${code}${err.trim() ? `: ${err.trim().split('\n').pop()}` : ''}` }));
  });
}

const REMUX_FORMAT = { '.mp4': 'mp4', '.m4v': 'mp4', '.mov': 'mov', '.webm': 'webm', '.mkv': 'matroska' };
// Stream copy into a hidden temp file next to the original, check it, then rename it over the original (atomic on
// one disk). The original keeps its modified time. Any failure leaves the original exactly as it was.
export async function remuxInPlace(path, { key = path, onProgress = () => {}, duration = 0 } = {}) {
  const ext = extname(path).toLowerCase(), fmt = REMUX_FORMAT[ext];
  if (!fmt) return { ok: false, error: 'not a format it can index' };
  const tmp = join(path, '..', `.${basename(path)}.index${ext}`);
  rmSync(tmp, { force: true });
  const before = statSync(path);
  const args = ['-y', '-v', 'error', '-nostdin', '-progress', 'pipe:1', '-i', path, '-map', '0:v', '-map', '0:a?', '-c', 'copy', '-map_metadata', '0',
    ...(fmt === 'mp4' || fmt === 'mov' ? ['-movflags', '+faststart'] : []), '-f', fmt, tmp];
  const r = await ffmpegJob(key, 'index', args, duration, onProgress);
  const fail = (error) => { rmSync(tmp, { force: true }); return { ok: false, error }; };
  if (!r.ok) return fail(r.error);
  try {
    const now = statSync(path);
    if (now.size !== before.size || now.mtimeMs !== before.mtimeMs) return fail('the file changed meanwhile');
    if (!statSync(tmp).size) return fail('ffmpeg wrote nothing');
    const idx = REMUX_FORMAT[ext] === 'mp4' || REMUX_FORMAT[ext] === 'mov' ? mp4Index(tmp) : mkvIndex(tmp);
    if (idx !== 'ok') return fail(`the indexed file is ${idx}`);
    const a = streamsOf(path), b = streamsOf(tmp);
    if (!b || (a && (a.v !== b.v || a.a !== b.a))) return fail('the indexed file lost a stream');
    if (a?.d && b.d && Math.abs(a.d - b.d) > Math.max(1, a.d * 0.01)) return fail(`the indexed file is ${b.d.toFixed(1)} s, not ${a.d.toFixed(1)} s`);
    utimesSync(tmp, before.atime, before.mtime);
    renameSync(tmp, path);
    return { ok: true, before: before.size, after: statSync(path).size };
  } catch (e) { return fail(e.message); }
}
function streamsOf(p) {
  try {
    const out = JSON.parse(String(execFileSync(ffprobe(), ['-v', 'error', '-show_entries', 'stream=codec_type:format=duration', '-of', 'json', p],
      { timeout: 60000, stdio: ['ignore', 'pipe', 'pipe'] })));
    const n = (t) => (out.streams || []).filter((s) => s.codec_type === t).length;
    return { v: n('video'), a: n('audio'), d: Number(out.format?.duration) || 0 };
  } catch { return null; }
}

const durations = new Map();
function duration(p) {
  if (durations.has(p)) return durations.get(p);
  try {
    const d = parseFloat(String(execFileSync(ffprobe(), ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', p], { timeout: 20000, stdio: ['ignore', 'pipe', 'pipe'] }))) || 0;
    if (d) durations.set(p, d);
    return d;
  } catch { return 0; }
}

// A keyframe every 15 frames: with libx264's default (250) a 720p copy scrubbed at 9 to 22 frames a second, this at 60.
const copyArgs = (src, out) => ['-y', '-v', 'error', '-progress', 'pipe:1', '-i', src, '-vf', 'scale=-2:720', ...h264('4M'), '-g', '15',
  '-c:a', 'aac', '-b:a', '192k', '-movflags', '+faststart', out];

// What a file needs now: { index, copy, why }. demand: the video is being edited (a deleted copy comes back).
export function playbackPlan(dir, f, { demand = false } = {}) {
  if (isAudio(f)) return { index: false, copy: false };
  const info = playInfo(join(dir, 'source', f));
  const hasCopy = existsSync(join(dir, proxyName(f)));
  const index = info?.ok === true && ['fragmented', 'moov-at-end', 'no-cues'].includes(info.index);
  const parked = Boolean(projectMeta(dir)?.copiesDeleted) && !demand;
  const copy = !hasCopy && (info?.ok !== true || (playbackMode(dir) === 'optimise' && !parked));
  return { index, copy, why: info?.ok === true ? null : info?.why || null, info };
}

// Prepare every video in source/ for playback, in the background (the name is kept from when this only made copies).
// Events: { t: 'job', id: <file>, quiet: true, … } (the page shows them as a small status, not in place of the canvas),
// then { t: 'files' } whenever what plays changes.
export function makeProxies(dir, onEvent = () => {}, { demand = false } = {}) {
  // A project folder made by hand (or by Claude) may have no work/ yet: ffmpeg can't write the copy there otherwise.
  try { mkdirSync(join(dir, 'work'), { recursive: true }); } catch {}
  if (demand && projectMeta(dir)?.copiesDeleted && playbackMode(dir) === 'optimise') saveProjectMeta(dir, { copiesDeleted: null });
  for (const f of sources(dir).filter((x) => !isAudio(x))) {
    const key = jobKey(dir, f);
    if (running.has(key)) continue;
    const plan = playbackPlan(dir, f, { demand });
    if (!plan.index && !plan.copy) continue;
    running.set(key, { kind: plan.index ? 'index' : 'copy', proc: null }); // marked now: the file mustn't move from here on
    runChain(dir, f, key, plan, onEvent).catch((e) => console.error(`Playback job for ${f} failed: ${e.message}`)).finally(() => running.delete(key));
  }
}
async function runChain(dir, f, key, plan, onEvent) {
  const src = join(dir, 'source', f);
  const total = duration(src);
  const ev = (o) => onEvent({ t: 'job', id: f, file: f, quiet: true, ...o });
  if (plan.index) {
    const label = `Indexing ${f} for seeking`;
    ev({ kind: 'index', label, progress: 0 });
    const r = await remuxInPlace(src, { key, duration: total, onProgress: (p) => ev({ kind: 'index', label, progress: p }) });
    if (r.ok) ev({ kind: 'index', label: `${f} indexed (no re-encode)`, progress: 1, done: true, ok: true });
    else ev({ kind: 'index', label: r.error === 'ENOENT' ? `Couldn't index ${f}: ffmpeg isn't on this computer (Setup → Tools installs it)` : `Couldn't index ${f} for seeking (${r.error}); it plays as it is`, progress: 1, done: true, ok: false, soft: true });
    onEvent({ t: 'files' });
    // The original couldn't be indexed: a copy gives the editor something it can seek in.
    if (!r.ok && r.error !== 'ENOENT' && !existsSync(join(dir, proxyName(f)))) plan = { ...plan, copy: true };
  }
  if (!plan.copy) return;
  const out = join(dir, proxyName(f)), part = `${out}.part.mp4`;
  const label = plan.why ? `Making a 720p copy of ${f} (the browser can't play it: ${plan.why})` : `Making a 720p editing copy of ${f}`;
  ev({ kind: 'copy', label, progress: 0, needed: Boolean(plan.why) });
  const r = await ffmpegJob(key, 'copy', copyArgs(src, part), total, (p) => ev({ kind: 'copy', label, progress: p, needed: Boolean(plan.why) }));
  if (r.ok) { try { renameSync(part, out); } catch {} }
  else rmSync(part, { force: true });
  const error = r.error === 'ENOENT' ? `Couldn't prepare ${f}: ffmpeg isn't on this computer (Setup → Tools installs it)` : `Couldn't prepare ${f} (${r.error})`;
  ev({ kind: 'copy', label: r.ok ? `${f} ready` : error, progress: 1, done: true, ok: r.ok });
  onEvent({ t: 'files' });
}

// ---- the copies on disk: list and delete ----
// Every work/proxy_*.mp4 of a video: { copy, file (its source file, or null for a left-over copy), bytes, needed (the
// original doesn't play in the browser, so this copy is what the editor plays) }.
export function copiesOf(dir) {
  let names = [];
  try { names = readdirSync(join(dir, 'work')).filter((n) => /^proxy_.+\.mp4$/.test(n) && !n.endsWith('.part.mp4')); } catch { return []; }
  const bySrc = new Map(sources(dir).filter((f) => !isAudio(f)).map((f) => [basename(proxyName(f)), f]));
  return names.map((n) => {
    const file = bySrc.get(n) || null;
    let bytes = 0; try { bytes = statSync(join(dir, 'work', n)).size; } catch {}
    const needed = Boolean(file) && playInfo(join(dir, 'source', file))?.ok !== true;
    return { copy: `work/${n}`, file, bytes, needed };
  });
}
export function copiesSummary(dir) {
  const list = copiesOf(dir), optional = list.filter((c) => !c.needed);
  return { bytes: list.reduce((t, c) => t + c.bytes, 0), files: list.length, editing: { bytes: optional.reduce((t, c) => t + c.bytes, 0), files: optional.length } };
}
// Delete a video's copies for good (re-creatable caches, not originals: no Bin). all: also the copies of files the
// browser can't play (they come back when the video is opened). A copy being made is left alone.
export function deleteCopies(dir, { all = false } = {}) {
  let bytes = 0, files = 0;
  const skipped = [];
  for (const c of copiesOf(dir)) {
    if (c.needed && !all) continue;
    if (c.file && running.has(jobKey(dir, c.file))) { skipped.push(c.file); continue; }
    try { rmSync(join(dir, c.copy)); bytes += c.bytes; files++; } catch {}
  }
  if (files && projectMeta(dir)) saveProjectMeta(dir, { copiesDeleted: Date.now() }); // (a folder made by hand gets no project.json)
  return { ok: true, bytes, files, skipped };
}
// Every video's copies, for Settings › Storage.
export function allCopies() {
  let names = [];
  try { names = readdirSync(projectsRoot()); } catch { return { bytes: 0, files: 0, projects: [] }; }
  const projects = [];
  for (const n of names) {
    if (n.startsWith('.') || n.startsWith('_')) continue;
    const dir = join(projectsRoot(), n);
    try { if (!statSync(dir).isDirectory()) continue; } catch { continue; }
    const s = copiesSummary(dir);
    if (s.files) projects.push({ id: n, name: projectMeta(dir)?.name || n, mode: playbackMode(dir), own: projectMeta(dir)?.playback || null, ...s });
  }
  projects.sort((a, b) => b.bytes - a.bytes);
  return { bytes: projects.reduce((t, p) => t + p.bytes, 0), files: projects.reduce((t, p) => t + p.files, 0), projects };
}
export function deleteAllCopies() {
  let bytes = 0, files = 0;
  for (const p of allCopies().projects) { const r = deleteCopies(join(projectsRoot(), p.id), { all: true }); bytes += r.bytes; files += r.files; }
  return { ok: true, bytes, files };
}

// The project view's playback: the mode, what plays for each file, jobs, copies.
export function playbackView(dir) {
  const meta = projectMeta(dir) || {};
  const files = {};
  for (const f of sources(dir)) {
    const s = playSource(dir, f);
    const info = isAudio(f) ? null : playInfo(join(dir, 'source', f));
    files[f] = { using: s.using, v: s.v, ...(s.why ? { why: s.why } : {}), ...(info?.slowSeek ? { slowSeek: info.gop } : {}) };
  }
  for (const j of playbackJobs(dir)) if (files[j.file]) files[j.file].job = j.kind;
  return { mode: playbackMode(dir), own: PLAYBACK_MODES.includes(meta.playback) ? meta.playback : null, settings: settingsMode(), copiesDeleted: Boolean(meta.copiesDeleted), files, copies: copiesSummary(dir) };
}
