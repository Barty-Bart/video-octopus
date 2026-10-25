// Playback (server/playback.mjs): Keep originals or Optimise for editing, the in-place index (remux, no re-encode),
// what the editor plays while a copy is made (never waits), the Cut Editor and timeline not waiting either, and
// deleting the 720p copies. Real FFmpeg on tiny synthetic media in a throwaway studio; absent FFmpeg is a skip.
// Run: node --test test/playback.test.mjs
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, statSync, utimesSync, copyFileSync, readdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const FF = process.env.TEST_FFMPEG || 'ffmpeg', FP = process.env.TEST_FFPROBE || 'ffprobe';
let tools = true;
try { execFileSync(FF, ['-version'], { stdio: 'pipe' }); execFileSync(FP, ['-version'], { stdio: 'pipe' }); } catch { tools = false; }
const need = (t) => { if (!tools) { t.skip('FFmpeg and ffprobe are required for this media test'); return false; } return true; };

const tmp = mkdtempSync(join(tmpdir(), 'vo-playback-'));
const studio = join(tmp, 'studio'), media = join(tmp, 'media'), local = join(tmp, 'local');
process.env.STUDIO_LOCAL_DIR = local;
mkdirSync(local, { recursive: true }); mkdirSync(media, { recursive: true }); mkdirSync(join(studio, 'projects'), { recursive: true });
const SETTINGS = join(local, 'settings.json');
const setSettings = (extra = {}) => writeFileSync(SETTINGS, JSON.stringify({ studio, ffmpeg: FF, ffprobe: FP, ...extra }));
setSettings();

let pb, studioMod, cut, timeline;
before(async () => {
  pb = await import('../server/playback.mjs');
  studioMod = await import('../server/studio.mjs');
  cut = await import('../server/cuteditor.mjs');
  timeline = await import('../server/timeline.mjs');
});
after(() => rmSync(tmp, { recursive: true, force: true }));

const run = (args) => execFileSync(FF, ['-v', 'error', '-y', ...args], { stdio: 'pipe', timeout: 60000 });
const SRC = (secs = 2, size = '320x180') => ['-f', 'lavfi', '-i', `testsrc2=size=${size}:rate=30`, '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000', '-t', String(secs)];
const X264 = ['-c:v', 'libx264', '-preset', 'veryfast', '-pix_fmt', 'yuv420p', '-g', '15'];
const fixtures = {};
function fixture(name, make) {
  if (!fixtures[name]) { const p = join(media, name); make(p); fixtures[name] = p; }
  return fixtures[name];
}
const okMp4 = () => fixture('ok.mp4', (p) => run([...SRC(), ...X264, '-c:a', 'aac', '-movflags', '+faststart', p]));
const lateMp4 = () => fixture('late.mp4', (p) => run([...SRC(), ...X264, '-c:a', 'aac', p])); // ffmpeg's default: moov at the end
const fragMp4 = () => fixture('frag.mp4', (p) => run([...SRC(), ...X264, '-c:a', 'aac', '-movflags', 'frag_keyframe+empty_moov+default_base_moof', p]));
const pcmMov = () => fixture('pcm.mov', (p) => run([...SRC(), ...X264, '-c:a', 'pcm_s16le', p]));
const mpeg4 = () => fixture('mpeg4.mp4', (p) => run([...SRC(), '-c:v', 'mpeg4', '-c:a', 'aac', p]));
const longGop = () => fixture('longgop.mp4', (p) => run([...SRC(10, '160x90'), '-c:v', 'libx264', '-preset', 'veryfast', '-pix_fmt', 'yuv420p', '-g', '250', '-sc_threshold', '0', '-c:a', 'aac', '-movflags', '+faststart', p]));
// MediaRecorder's WebM: written to a pipe, so it has no Cues (and no length) — the same as the browser's.
// (null when this FFmpeg has no VP8 / Opus encoder: those checks are skipped, said in the test's diagnostics)
const liveWebm = () => { try { return makeWebm(); } catch { return null; } };
const makeWebm = () => fixture('live.webm', (p) => writeFileSync(p, execFileSync(FF, ['-v', 'error', ...SRC(), '-c:v', 'libvpx', '-deadline', 'realtime', '-b:v', '1M', '-c:a', 'libopus', '-f', 'webm', 'pipe:1'], { maxBuffer: 64e6 })));

const hash = (p) => createHash('sha256').update(readFileSync(p)).digest('hex');
const streams = (p) => JSON.parse(String(execFileSync(FP, ['-v', 'error', '-show_entries', 'stream=codec_type,codec_name:format=duration', '-of', 'json', p]))) ;
const STAMP = '2026-10-25_10-00-00';
let n = 0;
function project(files, meta = {}) {
  const id = `p${++n}`, dir = join(studio, 'projects', id);
  mkdirSync(join(dir, 'source'), { recursive: true }); mkdirSync(join(dir, 'work'), { recursive: true });
  for (const [name, from] of Object.entries(files)) copyFileSync(from, join(dir, 'source', name));
  writeFileSync(join(dir, 'project.json'), JSON.stringify({ name: id, type: 'tutorial', takes: [STAMP], activeTake: STAMP, ...meta }));
  return dir;
}
const metaOf = (dir) => JSON.parse(readFileSync(join(dir, 'project.json'), 'utf8'));
const until = async (fn, ms = 60000) => { const t0 = Date.now(); for (;;) { const v = fn(); if (v) return v; if (Date.now() - t0 > ms) throw new Error('timed out'); await new Promise((r) => setTimeout(r, 50)); } };
const done = (events) => until(() => events.filter((e) => e.t === 'job').length && !studioMod.proxyRunning(events.dir, events.files) ? true : null);
function prepare(dir, opts) {
  const events = [];
  events.dir = dir; events.files = readdirSync(join(dir, 'source'));
  studioMod.makeProxies(dir, (e) => events.push(e), opts);
  return events;
}

test('the index check: faststart, index at the end, fragmented (MediaRecorder MP4), WebM without Cues', (t) => {
  if (!need(t)) return;
  assert.equal(pb.mp4Index(okMp4()), 'ok');
  assert.equal(pb.mp4Index(lateMp4()), 'moov-at-end');
  assert.equal(pb.mp4Index(fragMp4()), 'fragmented');
  if (liveWebm()) assert.equal(pb.mkvIndex(liveWebm()), 'no-cues'); else t.diagnostic('No VP8/Opus encoder: the WebM check is skipped');
  const junk = join(media, 'junk.mp4'); writeFileSync(junk, 'not a video');
  assert.equal(pb.mp4Index(junk), 'unknown', 'a file that is not an MP4 inside');
  const partial = join(media, 'partial.mp4'); writeFileSync(partial, readFileSync(okMp4()).subarray(0, 40));
  assert.equal(pb.mp4Index(partial), 'incomplete', 'an MP4 cut short (still being written)');
});

test('the browser plays: H.264 + AAC; not PCM sound in a .mov or an MPEG-4 picture; a long keyframe gap is slow to seek', (t) => {
  if (!need(t)) return;
  const ok = pb.playInfo(okMp4());
  assert.equal(ok.ok, true); assert.equal(ok.video, 'h264'); assert.equal(ok.slowSeek, false);
  assert.ok(ok.gop <= 0.6, `a keyframe every 15 frames, got ${ok.gop}`);
  assert.deepEqual([pb.playInfo(pcmMov()).ok, pb.playInfo(pcmMov()).why], [false, 'its sound is PCM']);
  assert.deepEqual([pb.playInfo(mpeg4()).ok, pb.playInfo(mpeg4()).why], [false, 'its picture is MPEG-4']);
  const slow = pb.playInfo(longGop());
  assert.equal(slow.ok, true); assert.equal(slow.slowSeek, true); assert.ok(slow.gop >= 8, `gap ${slow.gop}`);
  assert.equal(pb.playInfo(fragMp4()).index, 'fragmented');
});

test('remux in place: stream copy to a faststart, indexed file; same streams and length; the original keeps its time', async (t) => {
  if (!need(t)) return;
  for (const [name, src, check] of [['frag.mp4', fragMp4(), pb.mp4Index], ['late.mp4', lateMp4(), pb.mp4Index], ['live.webm', liveWebm(), pb.mkvIndex]]) {
    if (!src) { t.diagnostic(`No encoder for ${name}: skipped`); continue; }
    const p = join(media, `remux_${name}`);
    copyFileSync(src, p);
    const when = new Date('2026-10-20T10:00:00Z');
    utimesSync(p, when, when);
    const before = streams(p);
    const r = await pb.remuxInPlace(p);
    assert.equal(r.ok, true, `${name}: ${r.error}`);
    assert.equal(check(p), 'ok', name);
    const afterS = streams(p);
    assert.deepEqual(afterS.streams.map((s) => [s.codec_type, s.codec_name]), before.streams.map((s) => [s.codec_type, s.codec_name]), `${name}: no stream re-encoded or lost`);
    if (Number(before.format.duration)) assert.ok(Math.abs(Number(afterS.format.duration) - Number(before.format.duration)) < 0.1, name);
    assert.equal(statSync(p).mtimeMs, when.getTime(), `${name}: modified time kept`);
    assert.deepEqual(readdirSync(media).filter((f) => f.startsWith('.')), [], 'no temp file left');
  }
});

test('remux in place never loses the original: a failing ffmpeg leaves the same bytes and no temp file', async (t) => {
  if (!need(t)) return;
  const p = join(media, 'keep_frag.mp4');
  copyFileSync(fragMp4(), p);
  const h0 = hash(p);
  setSettings({ ffmpeg: process.execPath }); // Node as "ffmpeg": it refuses ffmpeg's arguments and exits non-zero
  try {
    const r = await pb.remuxInPlace(p);
    assert.equal(r.ok, false);
  } finally { setSettings(); }
  assert.equal(hash(p), h0, 'the original is byte for byte the same');
  assert.deepEqual(readdirSync(media).filter((f) => f.startsWith('.')), []);
  assert.equal(pb.mp4Index(p), 'fragmented', 'still the unindexed original');
});

test('Keep originals (default on a Mac): the original plays at once; a fragmented one is indexed in place, no copy is made', async (t) => {
  if (!need(t)) return;
  assert.equal(pb.DEFAULT_PLAYBACK, process.platform === 'darwin' ? 'originals' : 'optimise');
  const dir = project({ [`${STAMP}_webcam.mp4`]: fragMp4() }, { playback: 'originals' });
  const f = `${STAMP}_webcam.mp4`;
  assert.equal(pb.playbackMode(dir), 'originals');
  // Before anything runs, the canvas has something to play: the original (MediaRecorder's MP4 plays as it is).
  assert.deepEqual(pb.playSource(dir, f).src, `source/${f}`);
  const events = prepare(dir);
  assert.equal(studioMod.proxyRunning(dir, [f]), true, 'the file is marked busy while it is indexed (media guards)');
  assert.equal(pb.playSource(dir, f).src, `source/${f}`, 'still plays while it is indexed');
  await done(events);
  assert.equal(pb.mp4Index(join(dir, 'source', f)), 'ok');
  assert.equal(existsSync(join(dir, studioMod.proxyName(f))), false, 'no copy kept');
  const jobs = events.filter((e) => e.t === 'job');
  assert.ok(jobs.every((e) => e.quiet === true), 'quiet events: a small status, not bars in place of the canvas');
  assert.ok(jobs.some((e) => e.kind === 'index' && e.done && e.ok));
  assert.ok(events.some((e) => e.t === 'files'), 'the page refreshes what plays');
  assert.equal(pb.playbackView(dir).files[f].using, 'original');
  // An indexed, playable original needs nothing more.
  const again = prepare(dir);
  assert.equal(again.length, 0);
});

test('Keep originals: only a file the browser can’t play gets a 720p copy, and the view says why until it lands', async (t) => {
  if (!need(t)) return;
  const f = `${STAMP}_screen.mov`;
  const dir = project({ [f]: pcmMov() }, { playback: 'originals' });
  const s0 = pb.playSource(dir, f);
  assert.equal(s0.src, null); assert.equal(s0.why, 'its sound is PCM');
  const events = prepare(dir);
  const first = events.find((e) => e.t === 'job');
  assert.match(first.label, /Making a 720p copy of .+ \(the browser can't play it: its sound is PCM\)/);
  await done(events);
  const copy = studioMod.proxyName(f);
  assert.ok(existsSync(join(dir, copy)));
  assert.deepEqual(pb.playSource(dir, f), { src: copy, using: 'copy', v: pb.playSource(dir, f).v });
  const probe = streams(join(dir, copy)).streams;
  assert.deepEqual(probe.map((s) => s.codec_name), ['h264', 'aac']);
  // This copy is needed to play, so it isn't one of the "editing copies" offered for deletion after an export.
  assert.equal(pb.copiesSummary(dir).editing.files, 0);
  assert.equal(pb.copiesOf(dir)[0].needed, true);
});

test('Optimise for editing: the original plays while the 720p copy is made, then the copy (with short keyframe gaps)', async (t) => {
  if (!need(t)) return;
  const f = `${STAMP}_webcam.mp4`;
  const dir = project({ [f]: okMp4() }, { playback: 'optimise' });
  const events = prepare(dir);
  assert.equal(pb.playSource(dir, f).src, `source/${f}`, 'no waiting: the original meanwhile');
  assert.equal(pb.playbackView(dir).files[f].job, 'copy');
  await done(events);
  const copy = studioMod.proxyName(f);
  assert.equal(pb.playSource(dir, f).src, copy);
  const info = pb.playInfo(join(dir, copy));
  assert.ok(info.gop <= 0.6, `copy keyframe gap ${info.gop}`);
  const h = JSON.parse(String(execFileSync(FP, ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=height', '-of', 'json', join(dir, copy)]))).streams[0].height;
  assert.equal(h, 720, 'a 720p copy (scale=-2:720)');
  assert.ok(events.filter((e) => e.t === 'job').every((e) => e.quiet));
  // The video's own choice beats Settings; null follows Settings again.
  setSettings({ storage: { playback: 'originals' } });
  try { assert.equal(pb.playbackMode(dir), 'optimise'); writeFileSync(join(dir, 'project.json'), JSON.stringify({ ...metaOf(dir), playback: null })); assert.equal(pb.playbackMode(dir), 'originals'); }
  finally { setSettings(); }
  // Keep originals with a copy on disk: the original plays (it plays in the browser).
  writeFileSync(join(dir, 'project.json'), JSON.stringify({ ...metaOf(dir), playback: 'originals' }));
  assert.equal(pb.playSource(dir, f).src, `source/${f}`);
});

test('delete the copies after an export: for good, the needed ones stay; they come back only when edited with Optimise on', async (t) => {
  if (!need(t)) return;
  const cam = `${STAMP}_webcam.mp4`, scr = `${STAMP}_screen.mov`;
  const dir = project({ [cam]: okMp4(), [scr]: pcmMov() }, { playback: 'optimise' });
  await done(prepare(dir));
  assert.equal(pb.copiesOf(dir).length, 2);
  const sum = pb.copiesSummary(dir);
  assert.equal(sum.editing.files, 1, 'the PCM file’s copy is needed to play');
  assert.ok(sum.editing.bytes > 0 && sum.bytes > sum.editing.bytes);
  const listed = pb.allCopies().projects.find((p) => dir.endsWith(p.id));
  assert.equal(listed.files, 2); assert.equal(listed.mode, 'optimise');

  const r = pb.deleteCopies(dir);
  assert.deepEqual([r.ok, r.files], [true, 1]);
  assert.equal(existsSync(join(dir, studioMod.proxyName(cam))), false, 'deleted outright');
  assert.equal(existsSync(join(dir, studioMod.proxyName(scr))), true, 'the needed copy stays');
  assert.equal(existsSync(join(studio, '.trash')), false, 'not moved to a trash: copies are caches');
  assert.ok(existsSync(join(dir, 'source', cam)) && existsSync(join(dir, 'source', scr)), 'the originals stay');
  assert.ok(metaOf(dir).copiesDeleted);
  assert.equal(pb.playSource(dir, cam).src, `source/${cam}`, 'the original plays now');

  // Opening the video again doesn't remake them…
  assert.equal(prepare(dir).length, 0);
  // …editing it does, with Optimise on (index.mjs editedAgain / the page's Make it now: demand).
  const ev = prepare(dir, { demand: true });
  await done(ev);
  assert.ok(existsSync(join(dir, studioMod.proxyName(cam))));
  assert.equal(metaOf(dir).copiesDeleted, null);
  // With Keep originals, an edit doesn't bring an editing copy back.
  pb.deleteCopies(dir);
  writeFileSync(join(dir, 'project.json'), JSON.stringify({ ...metaOf(dir), playback: 'originals' }));
  assert.equal(prepare(dir, { demand: true }).length, 0);

  // Settings › Storage › Delete all copies: every copy, the needed ones too (they are made again when needed).
  const all = pb.deleteAllCopies();
  assert.ok(all.files >= 1);
  assert.equal(pb.copiesOf(dir).length, 0);
});

test('a copy being made is never deleted under ffmpeg, and its file can’t move (media guards)', async (t) => {
  if (!need(t)) return;
  const f = `${STAMP}_webcam.mp4`;
  const dir = project({ [f]: okMp4() }, { playback: 'optimise' });
  writeFileSync(join(dir, 'work', 'proxy_left-over.mp4'), 'an old copy');
  const events = prepare(dir);
  assert.equal(studioMod.proxyRunning(dir, [f]), true);
  const media = await import('../server/media.mjs');
  let sent = null;
  await media.mediaRoute({ method: 'POST' }, {}, { dir, action: '/media-remove', send: (res, code, b) => { sent = { code, b }; }, body: async () => ({ item: STAMP }) });
  assert.equal(sent.code, 409); assert.match(sent.b.error, /playback copy/);
  await done(events);
  assert.equal(studioMod.proxyRunning(dir, [f]), false);
  const r = pb.deleteCopies(dir);
  assert.equal(r.files, 2, 'the copy and a left-over copy of a file no longer in source/');
});

test('the Cut Editor and the timeline waveform don’t wait for a copy; the Cut Editor stays on the file it opened', async (t) => {
  if (!need(t)) return;
  const f = `${STAMP}_webcam.mp4`;
  const dir = project({ [f]: okMp4() }, { playback: 'optimise' });
  writeFileSync(join(dir, 'work', 'words.json'), JSON.stringify([[0.2, 0.6, 'Hello'], [0.7, 1.1, 'there.']]));
  const plan = cut.cutPlan(dir);
  assert.equal(plan.ready, true, plan.why);
  assert.equal(plan.video, `source/${f}`, 'opens on the original while there is no copy');
  const tl1 = await timeline.timelineData(dir);
  assert.ok(tl1.peaks?.data.length > 50, 'waveform from the original');
  const cache = join(dir, 'work', `peaks_${STAMP}_webcam.json`);
  const stamp1 = JSON.parse(readFileSync(cache, 'utf8')).stamp;
  await done(prepare(dir));
  assert.equal(cut.cutPlan(dir).video, studioMod.proxyName(f), 'a new Cut Editor page opens the copy');
  await timeline.timelineData(dir);
  assert.equal(JSON.parse(readFileSync(cache, 'utf8')).stamp, stamp1, 'the copy landing doesn’t read the waveform again');
  // A page opened on the original keeps getting the original (?f=), the copy only when it asks for it.
  const served = [];
  const serveFile = (req, res, file) => served.push(file);
  for (const q of [`?f=${encodeURIComponent(`source/${f}`)}`, '', '?f=..%2F..%2Fsecret']) {
    await cut.cutEditorRoute({ method: 'GET', url: `/api/projects/x/cut/video${q}` }, {}, { dir, what: 'video', send: () => {}, body: async () => ({}), serveFile });
  }
  assert.deepEqual(served.map((p) => p.slice(dir.length + 1).replace(/\\/g, '/')), [`source/${f}`, studioMod.proxyName(f), studioMod.proxyName(f)]);
  // A file the browser can't play at all is the only one the Cut Editor waits for.
  const dir2 = project({ [`${STAMP}_webcam.mov`]: pcmMov() }, { playback: 'originals' });
  writeFileSync(join(dir2, 'work', 'words.json'), JSON.stringify([[0.2, 0.6, 'Hi']]));
  assert.match(cut.cutPlan(dir2).why, /can't play .+ \(its sound is PCM\): a 720p playback copy is being made/);
});

test('web: the canvas never blocks on a copy, the status is quiet, the export offers to delete copies, Settings lists them', () => {
  const src = (p) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8').replace(/\r\n/g, '\n');
  const app = src('web/app.js');
  assert.match(app, /const src = \(f\) => playUrl\(P, f\);/);
  assert.doesNotMatch(app, /Getting your recording ready/);
  assert.match(app, /<span class="play-status" id="playStatus" role="status" hidden><\/span>/);
  assert.match(app, /filter\(\(j\) => !j\.quiet && !\(j\.id === 'export'/, 'quiet jobs are not full-width bars');
  assert.match(app, /swapSources\(P\);/, 'a copy landing swaps the source in place');
  assert.match(app, /askForPlayback\(P\);/, 'a video opened in Optimise without copies asks for them');
  assert.match(app, /Delete the 720p editing \$\{n === 1 \? 'copy' : 'copies'\} \(\$\{gb\(bytes\)\}\)\?/);
  assert.match(app, /Your originals and the export stay\./);
  assert.match(app, /deleted for good, not moved to the Bin/);
  assert.match(app, /Don’t ask again/);
  assert.match(app, /askDeleteCopies: false/);
  const settings = src('web/settings.js');
  assert.match(settings, /DRAW\.playback = \(V, save, redraw\) =>/);
  assert.match(settings, /\/api\/app\/playback-copies\/delete/);
  assert.match(settings, /Delete all copies/);
  assert.match(src('web/media.js'), /export function playbackCard\(pb, actions\)/);
  const idx = src('server/index.mjs');
  assert.match(idx, /const proxies = Object\.fromEntries\(r\.files\.map\(\(f\) => \[f, playSource\(dir, f\)\.src\]\)\);/);
  assert.match(idx, /if \(action === '\/playback-copies-delete'\)/);
  assert.match(src('web/cut-editor/index.html'), /\.then\(d=>\{setVideo\(d\.video\);/);
});
