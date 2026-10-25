// The Cut Editor (transcript + waveform cutting), built in: its page is web/cut-editor/ and these routes give it a
// project's newest words, cut and join files, the waveform, the video and the comments, and save the cut. No Python and
// no second server: the page runs on Video Octopus's own address (/cut-editor/?p=<project>), framed by the Cut tab.
//   GET  /api/projects/<id>/cut/data.json   the words, the waveform's peaks, the cut (the creator's save, else the plan's)
//   GET  /api/projects/<id>/cut/version     when the saved cut last changed ({version}: seconds, 0 = not saved yet)
//   GET  /api/projects/<id>/cut/video       the take it plays (the playback copy), with Range
//   GET  /api/projects/<id>/cut/notes       its comments (work/editor_notes.json); POST adds one, POST notes/delete removes one
//   POST /api/projects/<id>/cut/save        {segments, version, force} → work/edl_manual.json (409 when the file is newer)
// The files are the ones the separate editor (tools/cut-editor/server.py, before it was built in) read and wrote, in the
// same shape, so the skills, cutsync, the retime and every project made before keep working.
import { spawn, execFile } from 'node:child_process';
import { existsSync, statSync, realpathSync, writeFileSync } from 'node:fs';
import { join, dirname, basename, extname } from 'node:path';
import { readJSON, writeJSON, studioTool, childPathEnv } from './util.mjs';
import { roles, proxyName, isAudio } from './studio.mjs';
import { playSource } from './playback.mjs';
import { cutReadOnly, LOCKED_ERROR } from './cutreview.mjs'; // (read at call time: cutreview.mjs imports this module too)

const first = (dir, list) => list.find((f) => existsSync(join(dir, f))) || null;

// What the Cut Editor opens for this project, or why it can't open yet.
export function cutPlan(dir) {
  const r = roles(dir);
  if (!r.main) return { ready: false, why: 'Import a recording first.' };
  // What plays (server/playback.mjs): the 720p copy, else the original when the browser plays it; a mic-only take
  // opens as it is. Only a file the browser can't play at all waits for its copy.
  const play = playSource(dir, r.main), video = play.src;
  if (!video) return { ready: false, why: `The browser can't play ${r.main} (${play.why}): a 720p playback copy is being made.` };
  const words = first(dir, ['work/words_refined.json', 'work/editor_words.json', 'work/tr/words.json', 'work/words.json']);
  if (!words) return { ready: false, why: 'Transcribe first: the Cut Editor needs the word times.' };
  let edl = first(dir, ['work/edl_fixed.json', 'work/edl_editor_in.json', 'work/edl.json']);
  if (!edl) {
    // Start from the rough cut if there is one, else from the whole take.
    const map = readJSON(join(dir, 'work/rough_map.json'));
    const words_ = readJSON(join(dir, words), []);
    const end = map?.src_duration || (words_.length ? words_[words_.length - 1][1] + 1 : 0);
    const segments = map?.segments?.length ? map.segments.map((s) => s.src) : [[0, end]];
    writeJSON(join(dir, 'work/edl_editor_in.json'), { segments_sec: segments });
    edl = 'work/edl_editor_in.json';
  }
  const joins = first(dir, ['work/joins.json']);
  return { ready: true, video, words, edl, out: 'work/edl_manual.json', joins };
}

// ---- the waveform: 200 peaks a second of the take's sound, read once with ffmpeg (8 kHz mono) and kept in memory ----
const SR = 8000, PPS = 200, HOP = SR / PPS;
const waves = new Map(); // video path|mtime|size -> Promise<{ duration, fps, json }>, the newest few
const reading = new Set(); // ffmpeg and ffprobe while they run (closeAll stops them)
const r3 = (x) => Math.round(x * 1000) / 1000;

function ffprobePath() {
  const fp = studioTool('ffprobe');
  if (fp !== 'ffprobe') return fp;
  // Next to the ffmpeg in use (same folder, same .exe ending), else the PATH.
  const ff = studioTool('ffmpeg'), next = join(dirname(ff), `ffprobe${extname(ff)}`);
  return ff !== 'ffmpeg' && existsSync(next) ? next : 'ffprobe';
}

// The frame rate as ffprobe gives it (r_frame_rate); 30 for a take with no picture.
const rates = new Map(); // video path|mtime|size -> Promise<fps>
const fileKey = (file) => { const st = statSync(file); return `${file}|${st.mtimeMs}|${st.size}`; };
function frameRate(file) {
  const key = fileKey(file);
  if (!rates.has(key)) { rates.set(key, readRate(file)); while (rates.size > 8) rates.delete(rates.keys().next().value); }
  return rates.get(key);
}
async function readRate(file) {
  const env = await childPathEnv();
  return new Promise((done) => {
    const p = execFile(ffprobePath(), ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=r_frame_rate', '-of', 'csv=p=0', file],
      { timeout: 15000, env }, (err, out) => {
        reading.delete(p);
        const [n, d] = String(out || '').trim().split('/').map(Number);
        done(!err && n > 0 && d > 0 ? n / d : 30);
      });
    reading.add(p);
  });
}

// Peak and RMS level of every 1/200 s, scaled so the loudest 0.5% reaches the top (the shape the page draws).
async function readWave(file) {
  const env = await childPathEnv();
  const { peaks, rms, samples } = await new Promise((done, fail) => {
    const ff = spawn(studioTool('ffmpeg'), ['-v', 'error', '-i', file, '-ac', '1', '-ar', String(SR), '-f', 's16le', '-'], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    reading.add(ff);
    const pk = [], rm = [];
    let peak = 0, sq = 0, n = 0, total = 0, carry = null, err = '';
    ff.stdout.on('data', (buf) => {
      if (carry) { buf = Buffer.concat([carry, buf]); carry = null; }
      const even = buf.length - (buf.length % 2);
      if (even < buf.length) carry = buf.subarray(even);
      for (let i = 0; i < even; i += 2) {
        const x = Math.abs(buf.readInt16LE(i)) / 32768;
        if (x > peak) peak = x;
        sq += x * x;
        if (++n === HOP) { pk.push(peak); rm.push(Math.sqrt(sq / HOP)); peak = 0; sq = 0; n = 0; }
      }
      total += even / 2;
    });
    ff.stderr.on('data', (d) => { err = (err + d).slice(-2000); });
    ff.on('error', (e) => { reading.delete(ff); fail(new Error(e.code === 'ENOENT' ? 'ffmpeg was not found' : e.message)); });
    ff.on('close', (code) => {
      reading.delete(ff);
      if (code !== 0) return fail(new Error(err.trim().split('\n').slice(-2).join(' ') || `ffmpeg stopped (${code})`));
      done({ peaks: pk, rms: rm, samples: total }); // a last bit shorter than 1/200 s counts in the length, not in the peaks
    });
  });
  // The 99.5th percentile of the peaks, between the two nearest values (as numpy's percentile); 1 for silence.
  const sorted = Float64Array.from(peaks).sort();
  let norm = 0;
  if (sorted.length) {
    const h = (sorted.length - 1) * 0.995, lo = Math.floor(h), hi = Math.min(lo + 1, sorted.length - 1);
    norm = sorted[lo] + (h - lo) * (sorted[hi] - sorted[lo]);
  }
  norm = norm || 1;
  // Kept as JSON already: an hour of take is 720,000 values per row.
  const json = `"peaks":[${peaks.map((v) => r3(Math.min(1, v / norm))).join(',')}],"rms":[${rms.map((v) => r3(Math.min(1, (v / norm) * 2.2))).join(',')}]`;
  return { duration: samples / SR, json };
}

function wave(file) {
  const key = fileKey(file);
  if (!waves.has(key)) {
    const job = Promise.all([readWave(file), frameRate(file)]).then(([w, fps]) => ({ ...w, fps }));
    job.catch(() => waves.delete(key)); // a read that failed is tried again next time
    waves.set(key, job);
    while (waves.size > 4) waves.delete(waves.keys().next().value);
  }
  return waves.get(key);
}

// ---- the saved cut and the comments ----
const outPath = (dir, plan) => join(dir, plan.out);
// When the saved cut last changed, in seconds (0: not saved yet). A save made on an older version is refused.
const version = (dir, plan) => { try { return statSync(outPath(dir, plan)).mtimeMs / 1000; } catch { return 0; } };
const NOTES = 'work/editor_notes.json'; // next to the saved cut
const pad = (x) => String(x).padStart(2, '0');
const stamp = (d = new Date()) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
const round = (x, n) => Number(Number(x).toFixed(n));
// JSON as Python's json.dumps(indent=1) writes it (whole floats as 0.0, non-ASCII as \u escapes), so the files are
// byte for byte what the separate editor wrote. float(key): whether the numbers under that key are floats.
const pyStr = (s) => JSON.stringify(String(s)).replace(/[\u0080-\uffff]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`);
function pyJSON(v, float, d = 0, key = null) {
  const pad = ' '.repeat(d + 1), end = ' '.repeat(d);
  if (Array.isArray(v)) return v.length ? `[\n${v.map((x) => pad + pyJSON(x, float, d + 1, key)).join(',\n')}\n${end}]` : '[]';
  if (v && typeof v === 'object') {
    const e = Object.entries(v);
    return e.length ? `{\n${e.map(([k, x]) => `${pad}${pyStr(k)}: ${pyJSON(x, float, d + 1, k)}`).join(',\n')}\n${end}}` : '{}';
  }
  if (typeof v === 'number') return Number.isInteger(v) && float(key) ? v.toFixed(1) : String(v);
  return typeof v === 'string' ? pyStr(v) : JSON.stringify(v ?? null);
}
const loadNotes = (dir) => { const n = readJSON(join(dir, NOTES), []); return Array.isArray(n) ? n : []; };
const saveNotes = (dir, notes) => writeFileSync(join(dir, NOTES), pyJSON([...notes].sort((a, b) => a.t - b.t), (k) => k === 't' || k === 'edited_t'));
// The take's real path (links followed), as the saved cut names it.
const realPath = (p) => { try { return realpathSync(p); } catch { return p; } };

// The page's data, as JSON: the waveform's rows go in as they were kept.
export async function cutData(dir) {
  const plan = cutPlan(dir);
  if (!plan.ready) throw new Error(plan.why);
  const video = join(dir, plan.video), out = outPath(dir, plan);
  const w = await wave(video);
  const edl = readJSON(existsSync(out) ? out : join(dir, plan.edl), {});
  const joins = plan.joins ? readJSON(join(dir, plan.joins), {})?.joins || [] : [];
  const rest = JSON.stringify({ words: readJSON(join(dir, plan.words), []), segments: edl?.segments_sec || [], source: basename(video), video: plan.video, out,
    saved: existsSync(out), joins, version: version(dir, plan), locked: cutReadOnly(dir) });
  return `{"duration":${w.duration},"fps":${w.fps},"pps":${PPS},${w.json},${rest.slice(1)}`;
}

// The Cut tab opens the editor: the waveform is read now, so the page's data comes at once.
export async function openCutEditor(id, dir) {
  const plan = cutPlan(dir);
  if (!plan.ready) return { ok: false, why: plan.why };
  try { await wave(join(dir, plan.video)); } catch (e) { return { ok: false, why: `The Cut Editor couldn't read the sound of ${plan.video}: ${e.message}` }; }
  return { ok: true, url: `/cut-editor/?p=${encodeURIComponent(id)}`, plan };
}

// /api/projects/<id>/cut/<what>. Returns true when it answered.
export async function cutEditorRoute(req, res, { dir, what, send, body, serveFile }) {
  const plan = cutPlan(dir);
  if (!plan.ready) return send(res, 409, { error: plan.why }), true;
  if (req.method === 'GET') {
    if (what === 'data.json') {
      try {
        const json = await cutData(dir);
        res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
        return res.end(json), true;
      } catch (e) { return send(res, 500, { error: e.message }), true; }
    }
    if (what === 'version') return send(res, 200, { version: version(dir, plan) }), true;
    // ?f= the file the page opened with (data.json "video"), so a copy that lands mid-session doesn't swap the bytes
    // under the playing video; only the take's own copy or original is served.
    if (what === 'video') {
      const f = new URL(req.url, 'http://127.0.0.1').searchParams.get('f'), main = roles(dir).main;
      const ok = f && main && [proxyName(main), `source/${main}`].includes(f) && existsSync(join(dir, f));
      return serveFile(req, res, join(dir, ok ? f : plan.video)), true;
    }
    if (what === 'notes') return send(res, 200, loadNotes(dir)), true;
    return false;
  }
  const b = await body(req);
  if (what === 'notes') {
    const n = { id: Date.now(), at: stamp(), t: round(Number(b.t) || 0, 2), edited_t: round(Number(b.edited_t) || 0, 2), text: String(b.text ?? '').slice(0, 5000) };
    saveNotes(dir, [...loadNotes(dir), n]);
    return send(res, 200, n), true;
  }
  if (what === 'notes/delete') {
    saveNotes(dir, loadNotes(dir).filter((x) => x.id !== b.id));
    return send(res, 200, { ok: true }), true;
  }
  if (what === 'save') {
    // A locked cut is read-only (B3): Unlock to edit in the Cut tab first. The page knows (data.json locked) and doesn't try.
    if (cutReadOnly(dir)) return send(res, 409, { ok: false, locked: true, error: LOCKED_ERROR }), true;
    if (!b.force && (b.version == null || Math.abs(Number(b.version) - version(dir, plan)) > 1e-6)) return send(res, 409, { ok: false, conflict: true }), true;
    const segs = (Array.isArray(b.segments) ? b.segments : []).filter((s) => Array.isArray(s) && Number(s[1]) - Number(s[0]) > 0.02).map(([s, e]) => [round(s, 4), round(e, 4)]);
    if (segs.some((s) => !s.every(Number.isFinite))) return send(res, 400, { error: 'Bad segments.' }), true;
    const video = join(dir, plan.video), fps = await frameRate(video);
    // The file the separate editor wrote: the take's path and frame rate, the kept parts in take seconds, the length.
    const out = { source: realPath(video), fps, segments_sec: segs, saved_at: stamp(), edited_length: r3(segs.reduce((t, [s, e]) => t + e - s, 0)) };
    writeFileSync(outPath(dir, plan), pyJSON(out, (k) => k !== 'edited_length' || segs.length > 0)); // (Python's sum of nothing is a whole 0)
    return send(res, 200, { ok: true, length: out.edited_length, version: version(dir, plan) }), true;
  }
  return false;
}

// Stop a waveform still being read (Video Octopus is closing).
export function closeAll() { for (const p of reading) { try { p.kill(); } catch {} } reading.clear(); }
