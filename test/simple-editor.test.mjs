// V1 "ultra simple", steps 3 and 4 (handoff v1-simple-2026-10-26/SPEC.md §5–6, one-editor §0.2–0.3): the Simple
// editor's step card and step mapping (Audio only included), the after-Stop card's actions, the waveform's edits as
// cut operations and as writes to the one cut (work/edl_manual.json through /cut-save, refused while the cut is
// locked: B3), what Download gives, the tools' settings, Drop for Claude, the export options (caption looks, zoom
// effects) and the Simple hiding rules. Pure modules in place; the server parts on a real server in a disposable app
// and studio copy (no agent runs, no model is called). Windows-safe: forward-slash paths, plain file names, CRLF
// normalised.
//   node --test test/simple-editor.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawn, execFileSync } from 'node:child_process';
import { createServer } from 'node:net';
import { stepCard, simpleStepNow, roughCutState, progressLine, downloadTarget, exportOptions, cleanTools, toolsOf, SIMPLE_HIDDEN, ROUGH_CUT } from '../web/simple-flow.js';
import { normSegs, cutRange, restoreRange, splitAt, trimStart, trimEnd, gapsOf, takeToCut, wordCut, lengthOf } from '../web/simple-wave.js';
import { scaleZoom } from '../server/export-shots.mjs';
import { assFile } from '../server/export-words.mjs';

const APP = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const write = (path, value) => { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, value); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const lf = (s) => String(s).replace(/\r\n/g, '\n');
const src = (f) => lf(readFileSync(join(APP, f), 'utf8'));
const PIPE = JSON.parse(src('core/pipelines.json'));
const stepsOf = (type, done = []) => PIPE.formats[type].steps.map((s) => (typeof s === 'string' ? { id: s, ...PIPE.shared[s] } : s))
  .map((s) => ({ id: s.id, name: s.name || s.label || s.id, stage: s.stage || (s.id === 'plan' ? 'Plan' : ['intro', 'edit-short'].includes(s.id) ? 'Build' : ['review', 'zooms', 'post-kit'].includes(s.id) ? 'Polish' : null), optional: Boolean(s.optional), done: done.includes(s.id), skipped: false }));
// A project view as /api/projects/<id> gives it, for the step card.
const view = (type, { done = [], take = true, busy = false, running = null, extra = {} } = {}) => ({
  type, name: 'My video', busy, running, canvas: take ? { cam: 'take_webcam.mp4' } : {}, export: { duration: 71, cut: null },
  pipeline: { steps: stepsOf(type, take ? ['import', ...done] : done) }, renders: [], textExports: [], prepare: { needs: 0, summary: '' }, ...extra,
});

// ---------- the six steps and the card ----------
test('step mapping: Record → Rough cut (prepare, sections, lock) → Scenes → Build → Thumbnail → Download; Audio only skips Scenes and Build', () => {
  // no take: the Record page
  assert.equal(stepCard(view('tutorial', { take: false })).extra, 'record-page');
  // a take, nothing run: the after-Stop card, until Keep
  let c = stepCard(view('tutorial'));
  assert.equal(c.step, 'record');
  assert.equal(c.title, 'Got it, 1:11 recorded.');
  assert.deepEqual(c.buttons.map((b) => b.a), ['keep', 'again', 'delete']);
  assert.equal(c.buttons[0].label, 'Keep · Rough cut next');
  assert.equal(c.extra, 'takes');
  assert.equal(simpleStepNow(view('tutorial'), { kept: true }), 'rough-cut');
  // Rough cut runs back to back: running, at most one listen card, continue, done
  assert.equal(roughCutState(view('tutorial', { busy: true, running: 'prepare', done: ['import'] })).phase, 'running');
  const listen = view('tutorial', { done: ['import', 'prepare'], extra: { prepare: { needs: 2 } } });
  assert.equal(roughCutState(listen).phase, 'listen');
  assert.deepEqual(stepCard(listen, { kept: true }).buttons.map((b) => b.label), ['Listen', 'Keep it', 'Cut it']);
  assert.equal(roughCutState(listen, { listened: true }).phase, 'continue', 'one listen card at most');
  assert.equal(roughCutState(listen, { listened: true }).next, 'sections');
  assert.equal(stepCard(listen, { listened: true, chain: true }).busy, true, 'the chain goes on by itself');
  assert.deepEqual(ROUGH_CUT, ['prepare', 'sections', 'lock']);
  // Scenes: plan, then the approval
  const cutDone = ['import', 'prepare', 'sections', 'lock'];
  c = stepCard(view('tutorial', { done: cutDone }));
  assert.equal(c.step, 'scenes');
  assert.equal(c.buttons[0].a, 'plan');
  const approve = view('tutorial', { done: cutDone });
  approve.pipeline.steps.find((s) => s.id === 'plan').awaiting = 'approve';
  c = stepCard(approve, { sceneCount: 5 });
  assert.equal(c.title, 'Here’s the plan: 5 scenes.');
  assert.deepEqual(c.buttons.map((b) => b.label), ['Looks good, build it', 'Change something']);
  // Build: the per-scene progress as one card
  const building = view('tutorial', { done: [...cutDone, 'plan'], busy: true, running: 'intro', extra: { build: { total: 5, built: 2 }, runningAt: Date.now() - 120000 } });
  c = stepCard(building);
  assert.equal(c.step, 'build');
  assert.equal(c.lines[0], 'Scene 3 of 5');
  assert.equal(c.progress, 0.4);
  // Thumbnail (optional) before Download: Make six / Skip, then Use this one
  const built = view('tutorial', { done: [...cutDone, 'plan', 'intro'] });
  c = stepCard(built);
  assert.equal(c.step, 'thumbnail');
  assert.deepEqual(c.buttons.map((b) => b.a), ['make-thumbs', 'skip-thumb']);
  assert.deepEqual(stepCard(built, { thumbs: { state: 'ready', items: [], picked: 'x' } }).buttons.map((b) => b.label), ['Use this one', 'Skip']);
  const skipped = view('tutorial', { done: [...cutDone, 'plan', 'intro'] });
  skipped.pipeline.steps.find((s) => s.id === 'package').skipped = true;
  assert.equal(simpleStepNow(skipped), 'download');
  assert.equal(progressLine(skipped, 'download').find((s) => s.id === 'thumbnail').state, 'skipped');
  // Download: make the video, then it's ready
  assert.equal(stepCard(skipped).buttons[0].label, 'Make the video');
  const ready = { ...skipped, renders: [{ file: 'renders/my_camera_v1.mp4', kind: 'export', duration: 58 }] };
  c = stepCard(ready);
  assert.equal(c.title, 'Your video is ready: 0:58.');
  assert.equal(c.post, 'offer');
  // the progress line: six steps, Record and the rest
  assert.deepEqual(progressLine(ready, 'download').map((s) => s.label), ['Record', 'Rough cut', 'Scenes', 'Build', 'Thumbnail', 'Download']);

  // Audio only: Rough cut, then the podcast cover, then Download (no Scenes, no Build)
  const audio = view('audio', { done: ['import', 'prepare', 'sections', 'lock'] });
  assert.equal(simpleStepNow(audio), 'thumbnail');
  assert.match(stepCard(audio).title, /podcast cover/);
  const line = progressLine(audio, 'thumbnail');
  assert.equal(line.find((s) => s.id === 'scenes').state, 'skipped');
  assert.equal(line.find((s) => s.id === 'build').state, 'skipped');
  assert.equal(stepCard(view('audio')).lines[0], 'Keep it and I’ll clean it up: pauses, ums and retakes.');
});

test('errors are one sentence and one button', () => {
  const P = view('tutorial', { done: ['import', 'prepare'], extra: { unfinished: { step: 'sections' } } });
  const c = stepCard(P);
  assert.equal(c.error, true);
  assert.match(c.title, /^Claude stopped before finishing split into sections\.$/);
  assert.deepEqual(c.buttons.map((b) => b.label), ['Try again']);
  const d = stepCard({ ...view('tutorial', { done: ['import', 'prepare', 'sections', 'lock', 'plan', 'intro', 'package'] }) }, { exportError: 'ffmpeg is missing: Setup › Tools installs it.' });
  assert.equal(d.buttons.length, 1);
});

// ---------- what Download gives ----------
test('Download: the final MP4 for a video; for Audio only the cleaned audio (WAV, MP3) and the transcript', () => {
  assert.deepEqual(downloadTarget(view('tutorial')), { kind: 'video', files: [], ready: false });
  const P = view('tutorial', { extra: { renders: [{ file: 'renders/x_intro_v1.mp4', kind: 'build' }, { file: 'renders/x_camera_v2.mp4', kind: 'export' }, { file: 'renders/x_camera_v1.mp4', kind: 'export' }] } });
  assert.deepEqual(downloadTarget(P), { kind: 'video', files: [{ file: 'renders/x_camera_v2.mp4', label: 'Video (MP4)' }], ready: true }, 'the newest export, never a build');
  assert.equal(downloadTarget({ ...P, finalRender: 'renders/x_camera_v1.mp4' }).files[0].file, 'renders/x_camera_v1.mp4', 'the render marked final wins');
  const A = view('audio', { extra: { textExports: [
    { file: 'renders/a_transcript_v1.txt', kind: 'transcript', ext: 'txt' }, { file: 'renders/a_mix_v1.mp3', kind: 'audio', ext: 'mp3' }, { file: 'renders/a_mix_v1.wav', kind: 'audio', ext: 'wav' }] } });
  assert.deepEqual(downloadTarget(A).files.map((f) => f.label), ['Audio (WAV)', 'Audio (MP3)', 'Transcript']);
  assert.equal(downloadTarget(A).files[0].file, 'renders/a_mix_v1.wav');
  assert.equal(downloadTarget(view('audio', { extra: { textExports: [{ file: 'renders/a_transcript_v1.txt', kind: 'transcript', ext: 'txt' }] } })).ready, false, 'a transcript alone is not the download');
});

test('the tools: cleaned settings, and what the export gets (burned captions in a look, zoom effects)', () => {
  assert.deepEqual(cleanTools({}), { captions: { on: true, look: 'clean' }, effects: { zooms: true, intensity: 1 }, music: null });
  assert.deepEqual(cleanTools({ captions: { on: false, look: 'neon' }, effects: { zooms: false, intensity: 9 }, music: { cue: '' }, extra: 1 }),
    { captions: { on: false, look: 'clean' }, effects: { zooms: false, intensity: 2 }, music: null });
  assert.equal(toolsOf({ simpleTools: { captions: { look: 'boxed' } } }).captions.look, 'boxed');
  const o = exportOptions({ simpleTools: { captions: { on: true, look: 'bold' }, effects: { zooms: true, intensity: 1.4 } } });
  assert.equal(o.captions.look, 'bold');
  assert.equal(o.captions.maxLines, 2);
  assert.deepEqual(o.effects, { zooms: true, intensity: 1.4 });
  assert.equal(exportOptions({ simpleTools: { captions: { on: false } } }).captions, null);
  // the zoom intensity: punch-ins and boxes, kept inside the picture
  assert.ok(Math.abs(scaleZoom({ amount: 1.1 }, 2).amount - 1.2) < 1e-9);
  const z = scaleZoom({ box: { x: 0.6, y: 0.6, w: 0.4, h: 0.4 } }, 1.5).box;
  assert.ok(Math.abs(z.w - 0.15) < 1e-9 && z.x >= 0 && z.x + z.w <= 1 + 1e-9, 'never closer than 15 % of the picture');
  assert.deepEqual(scaleZoom({ id: 'z' }, 2), { id: 'z' });
  // the caption looks in the burned subtitles
  const cues = [{ start: 0, end: 1, lines: ['hello there'] }];
  assert.match(assFile(cues, 1920, 1080), /Shadow,,0,0,0,,\{\\blur/);
  assert.match(assFile(cues, 1920, 1080, 0, Infinity, 'bold'), /,,HELLO THERE\n/);
  assert.match(assFile(cues, 1920, 1080, 0, Infinity, 'boxed'), /Style: Caption,[^\n]*,3,\d+,0,2,/);
});

// ---------- the waveform's edits ----------
test('waveform edits as cut operations: Cut, Split, trim the ends, restore a greyed part, words crossed out', () => {
  const take = [[0.3, 5.6], [6.4, 20]];
  assert.deepEqual(cutRange(take, 2, 3), [[0.3, 2], [3, 5.6], [6.4, 20]]);
  assert.deepEqual(cutRange(take, 3, 1), [[0.3, 1], [3, 5.6], [6.4, 20]], 'a selection dragged backwards');
  assert.deepEqual(splitAt(take, 10), [[0.3, 5.6], [6.4, 10], [10, 20]]);
  assert.deepEqual(splitAt(take, 6), take, 'nothing to split in a cut part');
  assert.deepEqual(normSegs(splitAt(take, 10)), [[0.3, 5.6], [6.4, 10], [10, 20]], 'a split survives normalising');
  assert.deepEqual(trimStart(take, 2), [[2, 5.6], [6.4, 20]]);
  assert.deepEqual(trimStart(take, 0), [[0, 5.6], [6.4, 20]], 'dragged earlier: the start comes back');
  assert.deepEqual(trimStart(take, 6), [[6.4, 20]]);
  assert.deepEqual(trimEnd(take, 15), [[0.3, 5.6], [6.4, 15]]);
  assert.deepEqual(trimEnd(take, 22), [[0.3, 5.6], [6.4, 22]]);
  assert.deepEqual(gapsOf(take, 21), [[0, 0.3], [5.6, 6.4], [20, 21]]);
  assert.deepEqual(restoreRange(take, 5.6, 6.4), [[0.3, 20]], 'a click on Claude’s greyed pause brings it back');
  assert.equal(takeToCut(take, 7.4), 5.3 + 1);
  assert.ok(Math.abs(lengthOf(take) - 18.9) < 1e-9);
  assert.equal(wordCut(take, [5.8, 6.2, 'um']), true);
  assert.equal(wordCut(take, [7, 7.5, 'kit']), false);
});

// ---------- the server ----------
async function freePort() {
  return new Promise((done, fail) => { const s = createServer(); s.on('error', fail); s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => done(port)); }); });
}
// A WAV of silence (a mic-only take plays as it is, so the cut needs no ffmpeg).
function wav(seconds = 3, rate = 8000) {
  const n = Math.round(seconds * rate), b = Buffer.alloc(44 + n * 2);
  b.write('RIFF', 0); b.writeUInt32LE(36 + n * 2, 4); b.write('WAVE', 8); b.write('fmt ', 12); b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22);
  b.writeUInt32LE(rate, 24); b.writeUInt32LE(rate * 2, 28); b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34); b.write('data', 36); b.writeUInt32LE(n * 2, 40);
  return b;
}
async function startServer(t) {
  const root = mkdtempSync(join(realpathSync(tmpdir()), 'octopus-simple-ed-'));
  const app = join(root, 'app'), studio = join(root, 'studio'), home = join(root, 'home'), local = join(root, 'local');
  for (const dir of [app, studio, home, local]) mkdirSync(dir, { recursive: true });
  for (const dir of ['server', 'core', 'starter', 'web', 'bin']) cpSync(join(APP, dir), join(app, dir), { recursive: true });
  cpSync(join(APP, 'package.json'), join(app, 'package.json'));
  write(join(app, 'server/keychain.mjs'), `export const KEY_STORE = 'synthetic test fixture';
export async function readKey() { return null; }
export async function hasKey() { return false; }
export async function saveKey() { throw new Error('Fixture does not save credentials'); }
export async function removeKey() { throw new Error('Fixture does not remove credentials'); }
`);
  const port = await freePort();
  write(join(local, 'settings.json'), JSON.stringify({ studio, setup: { done: true, agent: '' }, updates: { auto: false }, scheduleCatchUp: false, help: { stepsIntro: 'dismissed' },
    claudePath: join(root, 'no-agent') }));
  write(join(local, 'schedules.json'), '{"v":1,"schedules":[]}');
  const env = {
    PATH: [dirname(process.execPath), process.env.PATH].join(process.platform === 'win32' ? ';' : ':'),
    HOME: home, USERPROFILE: home, TMPDIR: root, TMP: root, TEMP: root, STUDIO_LOCAL_DIR: local, STUDIO_NO_OPEN: '1', STUDIO_NO_SCHEDULES: '1',
    CLAUDE_CONFIG_DIR: join(home, '.claude'), HF_HUB_OFFLINE: '1', PORT: String(port), LC_ALL: 'C',
    ...(process.platform === 'win32' ? { SystemRoot: process.env.SystemRoot, ComSpec: process.env.ComSpec } : {}),
  };
  execFileSync(process.execPath, ['--input-type=module', '-e', 'const {createStudio}=await import(process.argv[1]);createStudio(process.argv[2],{use:false});',
    new URL(`file://${join(app, 'server/starter.mjs').replaceAll('\\', '/').replace(/^(?=[A-Za-z]:)/, '/')}`).href, studio], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  const child = spawn(process.execPath, [join(app, 'server/index.mjs')], { cwd: app, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let logs = '';
  child.stdout.on('data', (b) => { logs += b; });
  child.stderr.on('data', (b) => { logs += b; });
  const url = `http://127.0.0.1:${port}`;
  t.after(async () => {
    if (child.exitCode === null) { child.kill(); for (let i = 0; i < 50 && child.exitCode === null && child.signalCode === null; i++) await sleep(100); }
    rmSync(root, { recursive: true, force: true, maxRetries: 5 });
  });
  const req = async (path, data, raw = null) => {
    const r = await fetch(url + path, raw ? { method: 'POST', headers: { 'X-Studio': '1', 'Content-Type': 'application/octet-stream' }, body: raw }
      : data === undefined ? {} : { method: 'POST', headers: { 'X-Studio': '1', 'Content-Type': 'application/json' }, body: JSON.stringify(data) });
    const text = await r.text();
    let body; try { body = JSON.parse(text); } catch { body = text; }
    return { status: r.status, body };
  };
  const ok = async (path, data, raw) => { const r = await req(path, data, raw); assert.equal(r.status, 200, `${path}: ${JSON.stringify(r.body)}\n${logs.slice(-1500)}`); return r.body; };
  for (let i = 0; i < 200; i++) {
    if (child.exitCode !== null) throw new Error(logs);
    try { if ((await fetch(`${url}/api/learning`)).ok) break; } catch {}
    await sleep(100);
  }
  return { studio, req, ok };
}

test('server: the waveform writes the one cut (edl_manual through /cut-save), refused while locked (B3); takes, drops and tools', { timeout: 60000 }, async (t) => {
  const s = await startServer(t);
  const { id } = await s.ok('/api/projects', { untitled: true, shape: 'audio' });
  const dir = join(s.studio, 'projects', id), base = `/api/projects/${encodeURIComponent(id)}`;
  // A dropped recording is the take (the existing /take-upload, as Simple's Record page uses it).
  await s.ok(`${base}/take-upload?name=voice.wav`, undefined, wav(3));
  let items = (await s.ok(`${base}/media-items`)).items.filter((x) => x.take);
  assert.equal(items.length, 1);
  assert.equal(items[0].canvas, true);
  // Delete take (an imported file: /media-remove), soft, then Undo (/media-restore): the take is back.
  const del = await s.ok(`${base}/media-remove`, { item: items[0].id, confirm: true });
  assert.ok(del.trash);
  assert.equal((await s.ok(`${base}/media-items`)).items.filter((x) => x.take).length, 0);
  await s.ok(`${base}/media-restore`, { trash: del.trash });
  items = (await s.ok(`${base}/media-items`)).items.filter((x) => x.take);
  assert.equal(items.length, 1, 'Undo brings the take back');

  // The cut: words and a rough cut (what Clean up writes), then the waveform's edits through /cut-save.
  write(join(dir, 'work/tr/words.json'), JSON.stringify([[0.2, 0.6, 'Hello'], [0.7, 1.0, 'um'], [1.3, 1.8, 'world'], [2.0, 2.6, 'again']]));
  write(join(dir, 'work/edl_fixed.json'), JSON.stringify({ segments_sec: [[0.1, 0.65], [1.2, 2.8]] }));
  let take = await s.ok(`${base}/cut-take`);
  assert.equal(take.ok, true, JSON.stringify(take));
  const next = cutRange(take.segments, 2.0, 2.6);
  const saved = await s.ok(`${base}/cut-save`, { segments: next, version: take.version });
  assert.equal(saved.ok, true);
  const manual = JSON.parse(lf(readFileSync(join(dir, 'work/edl_manual.json'), 'utf8')));
  assert.deepEqual(manual.segments_sec, [[0.1, 0.65], [1.2, 2], [2.6, 2.8]], 'the pipeline reads this cut');
  take = await s.ok(`${base}/cut-take`);
  assert.deepEqual(take.segments, manual.segments_sec);
  // Restore Claude's greyed part
  await s.ok(`${base}/cut-save`, { segments: restoreRange(take.segments, 0.65, 1.2), version: take.version });
  assert.deepEqual(JSON.parse(lf(readFileSync(join(dir, 'work/edl_manual.json'), 'utf8'))).segments_sec[0], [0.1, 2]);

  // B3: Lock the cut wrote "Cut locked": the route refuses; Unlock to edit (the Cut tab's own) opens it again.
  const cur = JSON.parse(lf(readFileSync(join(dir, 'work/edl_manual.json'), 'utf8'))).segments_sec;
  write(join(dir, 'work/edl_fixed.json'), JSON.stringify({ segments_sec: cur }));
  writeFileSync(join(dir, 'WORKLOG.md'), `${lf(readFileSync(join(dir, 'WORKLOG.md'), 'utf8'))}- 2026-10-26: Cut locked (join-check: 1 join)\n`);
  take = await s.ok(`${base}/cut-take`);
  const locked = await s.req(`${base}/cut-save`, { segments: cutRange(take.segments, 0.2, 0.3), version: take.version });
  assert.equal(locked.status, 409);
  assert.equal(locked.body.locked, true);
  assert.equal((await s.ok(base)).export.cut.state, 'locked');
  await s.ok(`${base}/cut-review`, { op: 'unlock' });
  take = await s.ok(`${base}/cut-take`);
  assert.equal((await s.ok(`${base}/cut-save`, { segments: cutRange(take.segments, 0.2, 0.3), version: take.version })).ok, true);
  assert.equal((await s.ok(base)).pipeline.steps.find((x) => x.id === 'lock').done, false, 'Lock the cut is next again');

  // Drop for Claude: the file stays with the project, in source/; not a take, and only known kinds come in.
  const png = Buffer.from('89504e470d0a1a0a', 'hex');
  const drop = await s.ok(`${base}/drop?name=app-screenshot.png`, undefined, png);
  assert.equal(drop.file, 'source/app-screenshot.png');
  assert.ok(existsSync(join(dir, 'source/app-screenshot.png')));
  assert.match(lf(readFileSync(join(dir, 'WORKLOG.md'), 'utf8')), /Added app-screenshot\.png to source\/ \(dropped for Claude\)/);
  assert.equal((await s.ok(`${base}/media-items`)).items.filter((x) => x.take).length, 1, 'a picture is not a take');
  assert.equal((await s.req(`${base}/drop?name=run.exe`, undefined, png)).status, 400);

  // The tools: saved in project.json, cleaned, and in the project view.
  const tools = await s.ok(`${base}/simple-tools`, { captions: { on: true, look: 'boxed' }, effects: { zooms: false } });
  assert.deepEqual(tools.simpleTools, { captions: { on: true, look: 'boxed' }, effects: { zooms: false, intensity: 1 }, music: null });
  assert.deepEqual((await s.ok(base)).simpleTools, tools.simpleTools);
  // Thumbnail's Skip: the optional Package step skipped (Simple's progress then shows it skipped).
  await s.ok(`${base}/rail`, { op: 'skip', step: 'package' });
  assert.equal((await s.ok(base)).pipeline.steps.find((x) => x.id === 'package').skipped, true);
});

// ---------- hiding rules ----------
test('Simple hides the Advanced surfaces (CSS and gates); Advanced keeps beta.23’s editor', () => {
  const css = src('web/simple.css');
  const hidden = css.slice(0, css.indexOf('{ display: none !important; }'));
  for (const h of SIMPLE_HIDDEN) assert.ok(hidden.includes(h.sel.startsWith('#') && ['#rail', '#recBtn', '#exportBtn'].includes(h.sel) ? `body.simple-editor ${h.sel}` : `.project.simple ${h.sel}`), `${h.what} (${h.sel}) is hidden`);
  // every Simple rule is scoped: nothing here restyles Advanced
  const rules = css.replace(/\/\*[\s\S]*?\*\//g, '').replace(/@media[^{]+\{|@keyframes[^{]+\{[^}]*\}\s*\}?/g, '').match(/[^{}]+(?=\{)/g).map((x) => x.trim()).filter(Boolean);
  for (const sel of rules.flatMap((r) => r.split(','))) assert.match(sel.trim(), /^(\.project\.simple|body\.simple-editor|body\.sx-dragging|body\.vt-open|html\[data-mode=simple\]|\.sx-|\.sw-|\.vt|\.linkish|to$)/, `scoped: ${sel}`);
  assert.match(src('web/index.html'), /<link rel="stylesheet" href="\/simple.css">/);
  const app = src('web/app.js');
  assert.match(app, /if \(!isAdvanced\(\)\) \{\n\s+pendingRecord = [^\n]+\n\s+simple = mountSimpleEditor\(/, 'the Simple editor mounts only in Simple');
  assert.match(app, /const foldKeys = \(e\) => \{ if \(!isAdvanced\(\)\) return;/, 'no ⌘J fold in Simple');
  assert.match(app, /octopus-memory[^\n]+isAdvanced\(\) \? `\\n\[Proposed lessons → Review in Memories\]/, 'the chat’s Memories link is Advanced only');
  assert.match(app, /if \(!isAdvanced\(\)\) return; \/\/ Simple mode: no layout editing on the picture/, 'no editing marks on the picture');
  assert.match(src('web/settings.js'), /if \(!isAdvanced\(\)\) return; \/\/ Simple mode: no assistant drawer/, 'no ⌘J drawer in Simple');
  assert.match(src('web/updates.js'), /const skillParts = isAdvanced\(\) \? \[preferences, skillGroup\] : \[\];/, 'skill updates are Advanced only');
  // nothing in the Simple editor offers the hidden surfaces
  const ed = src('web/simple-editor.js') + src('web/simple-record.js') + src('web/simple-flow.js');
  for (const word of ['change package', 'Comment WORD', 'checklist', '#/styles', '#/skills', '#/library', 'Review lessons']) assert.ok(!ed.includes(`'${word}`) && !ed.includes(`"${word}`), word);
});
