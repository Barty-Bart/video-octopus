// Recording controls on the server side (server/browser-recorder.mjs): Restart drops the take it was recording
// (it never becomes a take or an unsaved one), Pause keeps the take alive without chunks, and Delete take moves a
// take to the studio's trash with an Undo that puts everything back, refusing a take another project uses or one
// its project has already cut. Plus static checks of the web side (tokens-only CSS, the stylesheet is linked, the
// script's buttons cover its keys). A throwaway studio and settings folder: nothing real is touched.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync, rmSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const tmp = mkdtempSync(join(tmpdir(), 'vo-rec-controls-'));
const studio = join(tmp, 'studio');
const recordings = join(studio, 'recordings');
const projects = join(studio, 'projects');
process.env.STUDIO_LOCAL_DIR = join(tmp, 'local');
mkdirSync(process.env.STUDIO_LOCAL_DIR, { recursive: true });
writeFileSync(join(process.env.STUDIO_LOCAL_DIR, 'settings.json'), JSON.stringify({ studio }));
mkdirSync(recordings, { recursive: true });

let rec, studioMod;
before(async () => {
  rec = await import('../server/browser-recorder.mjs');
  studioMod = await import('../server/studio.mjs');
});
after(() => rmSync(tmp, { recursive: true, force: true }));

const readJ = (p) => JSON.parse(readFileSync(p, 'utf8'));
const writeJ = (p, v) => { mkdirSync(join(p, '..'), { recursive: true }); writeFileSync(p, JSON.stringify(v, null, 2)); };
const trash = () => join(studio, '.trash');
const trashEntries = () => (existsSync(trash()) ? readdirSync(trash()) : []);

function project(id, meta = {}) {
  const dir = join(projects, id);
  mkdirSync(join(dir, 'source'), { recursive: true });
  mkdirSync(join(dir, 'work'), { recursive: true });
  writeJ(join(dir, 'project.json'), { name: id.toUpperCase(), ...meta });
  return dir;
}

// One route call, the way server/index.mjs makes it.
async function call(id, action, payload = {}, { method = 'POST', query = '', chunk } = {}) {
  const url = new URL(`http://127.0.0.1/api/projects/${id}${action}${query ? `?${query}` : ''}`);
  const req = chunk ? Object.assign([Buffer.from(chunk)], { method }) : { method };
  const events = [];
  let out = null;
  const answered = await rec.recRoute(req, {}, {
    id, action, url,
    send: (_res, code, body) => { out = { code, body }; },
    body: async () => payload,
    emit: (ev) => events.push(ev),
    receiveTake: () => {},
  });
  assert.equal(answered, true);
  return { ...out, events };
}
const start = (id) => call(id, '/rec-start', { kind: 'camera', target: 'replace', tracks: { webcam: { mime: 'video/webm;codecs=vp9,opus' } } });
const chunk = (id, take, seq, text) => call(id, '/rec-chunk', null, { query: `take=${take}&track=webcam&seq=${seq}`, chunk: text });
const takeJson = (take) => readJ(join(recordings, take, 'take.json'));
const makeStale = (take) => { const t = takeJson(take); writeJ(join(recordings, take, 'take.json'), { ...t, updated: Date.now() - 60000 }); };

test('Restart discards the take being recorded: no take, no unsaved take, its folder in the trash', async () => {
  project('rs');
  const r = await start('rs');
  assert.equal(r.code, 200);
  const take = r.body.take;
  assert.equal((await chunk('rs', take, 0, 'first second')).code, 200);
  assert.equal((await chunk('rs', take, 1, 'second second')).code, 200);

  const d = await call('rs', '/rec-discard', { take });
  assert.equal(d.code, 200, JSON.stringify(d.body));
  assert.equal(existsSync(join(recordings, take)), false, 'the half-take left the recordings folder');
  const entry = join(trash(), d.body.trash);
  assert.ok(existsSync(join(entry, 'take', `${take}_webcam.webm.part`)), 'its parts are kept in the trash');
  assert.equal(readJ(join(entry, 'take', 'take.json')).discarded > 0, true);
  assert.equal(readJ(join(entry, 'manifest.json')).kind, 'discarded');

  // Nothing offers it again, nothing waits on it, and nothing more can be added to or saved from it.
  assert.deepEqual(rec.unfinishedTakes('rs'), []);
  assert.equal(rec.recorderBusy(), false);
  assert.equal((await chunk('rs', take, 2, 'late chunk')).code, 400);
  assert.equal((await call('rs', '/rec-finish', { take })).code, 400);
  assert.ok(studioMod.listTakes().every((t) => t.id !== take), 'not in the recordings list');

  // The fresh take after it is the only one.
  const again = await start('rs');
  assert.equal(again.code, 200);
  assert.deepEqual(readdirSync(recordings).filter((n) => !n.startsWith('.')), [again.body.take]);
  assert.equal((await call('rs', '/rec-discard', { take: again.body.take })).code, 200);
});

test('a discarded take that is still in the recordings folder (a move that failed) is never offered', async () => {
  project('rs2');
  const take = (await start('rs2')).body.take;
  await chunk('rs2', take, 0, 'bytes');
  writeJ(join(recordings, take, 'take.json'), { ...takeJson(take), discarded: Date.now(), updated: Date.now() - 60000 });
  assert.deepEqual(rec.unfinishedTakes('rs2'), []);
  assert.equal(rec.recorderBusy(), false);
  rmSync(join(recordings, take), { recursive: true, force: true });
});

test('Pause keeps the take alive without chunks; chunks after Resume append in order', async () => {
  project('pz');
  const take = (await start('pz')).body.take;
  await chunk('pz', take, 0, 'aaaa');
  makeStale(take); // as if the recorder had been paused for a minute
  assert.equal(rec.unfinishedTakes('pz').length, 1, 'without the pause heartbeat it would look like a closed page');

  const p = await call('pz', '/rec-pause', { take, paused: true });
  assert.equal(p.code, 200);
  assert.deepEqual(rec.unfinishedTakes('pz'), [], 'paused and still alive');
  let t = takeJson(take);
  assert.equal(t.paused, true);
  assert.equal(t.pauses.length, 1);
  assert.equal(t.pauses[0].resumed, null);
  // The heartbeat while paused doesn't add pauses.
  await call('pz', '/rec-pause', { take, paused: true });
  assert.equal(takeJson(take).pauses.length, 1);

  await call('pz', '/rec-pause', { take, paused: false });
  t = takeJson(take);
  assert.equal(t.paused, false);
  assert.ok(t.pauses[0].resumed >= t.pauses[0].at);
  await chunk('pz', take, 1, 'bbb');
  t = takeJson(take);
  assert.equal(t.tracks.webcam.next, 2);
  assert.equal(readFileSync(join(recordings, take, `${take}_webcam.webm.part`), 'utf8'), 'aaaabbb');

  // A page that closes while paused stops the heartbeat: the take is offered as unsaved, as before.
  await call('pz', '/rec-pause', { take, paused: true });
  makeStale(take);
  assert.equal(rec.unfinishedTakes('pz').length, 1);
  assert.equal((await call('pz', '/rec-discard', { take })).code, 200);
});

// A saved take as the recorder leaves it, already copied into its project.
function savedTake(stamp, id, { files = [`${stamp}_webcam.mp4`], finished = Date.now() } = {}) {
  const dir = join(recordings, stamp);
  mkdirSync(dir, { recursive: true });
  for (const f of files) writeFileSync(join(dir, f), `media ${f}`);
  writeJ(join(dir, 'take.json'), { recorder: 'browser', project: id, finished, files, tracks: {} });
  const pdir = join(projects, id);
  for (const f of files) {
    writeFileSync(join(pdir, 'source', f), `media ${f}`);
    writeFileSync(join(pdir, studioMod.proxyName(f)), `proxy ${f}`);
  }
  return dir;
}

test('Delete take moves it to the trash and back out of its project; Undo restores everything', async () => {
  const stamp = '2026-10-24_10-00-00';
  const pdir = project('del', {
    takes: ['2026-10-23_09-00-00', stamp], activeTake: stamp, activeSince: 1234,
    layout: { preset: 'pip', layers: [{ file: 'source/other_webcam.mp4' }] },
  });
  writeFileSync(join(pdir, 'source', '2026-10-23_09-00-00_webcam.mp4'), 'older take');
  savedTake(stamp, 'del');

  const d = await call('del', '/rec-delete', { take: stamp });
  assert.equal(d.code, 200, JSON.stringify(d.body));
  assert.deepEqual(d.events, [{ t: 'files' }], 'the project page refreshes');
  assert.equal(d.body.activeTake, '2026-10-23_09-00-00');
  assert.equal(existsSync(join(recordings, stamp)), false);
  assert.equal(existsSync(join(pdir, 'source', `${stamp}_webcam.mp4`)), false);
  assert.equal(existsSync(join(pdir, studioMod.proxyName(`${stamp}_webcam.mp4`))), false);
  assert.ok(existsSync(join(pdir, 'source', '2026-10-23_09-00-00_webcam.mp4')), 'the older take is untouched');
  let meta = readJ(join(pdir, 'project.json'));
  assert.deepEqual(meta.takes, ['2026-10-23_09-00-00']);
  assert.equal(meta.activeTake, '2026-10-23_09-00-00');
  assert.deepEqual(meta.layout.layers, [{ file: 'source/other_webcam.mp4' }]);

  const entry = join(trash(), d.body.trash);
  assert.equal(readFileSync(join(entry, 'take', `${stamp}_webcam.mp4`), 'utf8'), `media ${stamp}_webcam.mp4`, 'the original is kept, byte for byte');
  assert.ok(existsSync(join(entry, 'project', 'source', `${stamp}_webcam.mp4`)));
  const m = readJ(join(entry, 'manifest.json'));
  assert.equal(m.kind, 'deleted');
  assert.equal(m.project, 'del');
  assert.match(readFileSync(join(pdir, 'WORKLOG.md'), 'utf8'), /Deleted take 2026-10-24_10-00-00: moved to the studio's trash/);

  const u = await call('del', '/rec-restore', { trash: d.body.trash });
  assert.equal(u.code, 200, JSON.stringify(u.body));
  assert.ok(existsSync(join(recordings, stamp, `${stamp}_webcam.mp4`)));
  assert.ok(existsSync(join(recordings, stamp, 'take.json')));
  assert.ok(existsSync(join(pdir, 'source', `${stamp}_webcam.mp4`)));
  assert.ok(existsSync(join(pdir, studioMod.proxyName(`${stamp}_webcam.mp4`))));
  meta = readJ(join(pdir, 'project.json'));
  assert.deepEqual(meta.takes, ['2026-10-23_09-00-00', stamp]);
  assert.equal(meta.activeTake, stamp);
  assert.equal(meta.activeSince, 1234);
  assert.equal(existsSync(entry), false, 'the emptied trash entry goes');
  assert.equal((await call('del', '/rec-restore', { trash: d.body.trash })).code, 400, 'a second Undo has nothing to do');
});

test('Delete take of a layer or a block take takes the layer out or empties the block; Undo puts it back', async () => {
  const stamp = '2026-10-24_11-00-00';
  const layer = { file: `source/${stamp}_webcam.mp4`, x: 0.8 };
  const pdir = project('lay', { takes: ['first', stamp], activeTake: 'first', layout: { layers: [layer] } });
  savedTake(stamp, 'lay');
  writeJ(join(pdir, 'work', 'blocks.json'), { v: 1, blocks: [{ id: 'sp', type: 'sponsor', label: 'Sponsor', source: { file: `source/${stamp}_webcam.mp4` } }] });

  const d = await call('lay', '/rec-delete', { take: stamp });
  assert.equal(d.code, 200, JSON.stringify(d.body));
  let meta = readJ(join(pdir, 'project.json'));
  assert.equal(meta.activeTake, 'first', 'the canvas take stays');
  assert.deepEqual(meta.layout.layers, []);
  assert.deepEqual(readJ(join(pdir, 'work', 'blocks.json')).blocks[0].source, { pending: 'record' });

  assert.equal((await call('lay', '/rec-restore', { trash: d.body.trash })).code, 200);
  meta = readJ(join(pdir, 'project.json'));
  assert.deepEqual(meta.layout.layers, [layer]);
  assert.equal(meta.activeTake, 'first');
  assert.deepEqual(readJ(join(pdir, 'work', 'blocks.json')).blocks[0].source, { file: `source/${stamp}_webcam.mp4` });
});

test('Delete take asks first for a take another project uses or one already cut (naming the videos), and goes ahead on confirm', async () => {
  const stamp = '2026-10-24_12-00-00';
  const pdir = project('own', { takes: [stamp], activeTake: stamp });
  const odir = project('other', { name: 'Other video', takes: [stamp] });
  writeFileSync(join(odir, 'source', `${stamp}_webcam.mp4`), 'other copy');
  const finished = Date.now() - 10 * 60000;
  savedTake(stamp, 'own', { finished });
  const before = JSON.stringify(readJ(join(pdir, 'project.json')));

  let d = await call('own', '/rec-delete', { take: stamp });
  assert.equal(d.code, 200);
  assert.equal(d.body.ok, false);
  assert.match(d.body.confirm, /^“Other video” also uses this take\. It keeps its own copy, so it won’t change\.$/);
  assert.deepEqual(d.body.videos, [{ id: 'other', name: 'Other video' }], 'the video is named with its id, for a link');
  assert.ok(existsSync(join(recordings, stamp, `${stamp}_webcam.mp4`)), 'nothing moved before the answer');
  assert.ok(existsSync(join(pdir, 'source', `${stamp}_webcam.mp4`)));
  assert.equal(JSON.stringify(readJ(join(pdir, 'project.json'))), before);

  // Also a cut made after the take arrived: both said in one question, untruncated.
  utimesSync(join(pdir, 'source', `${stamp}_webcam.mp4`), new Date(finished), new Date(finished));
  writeJ(join(pdir, 'work', 'edl_manual.json'), { cuts: [] });
  d = await call('own', '/rec-delete', { take: stamp });
  assert.equal(d.body.ok, false);
  assert.match(d.body.confirm, /also uses this take\. .* This take is already cut in “OWN”\. That work stays in the project, but it belongs to this take: the video goes back to the take it had before\.$/);
  assert.equal(trashEntries().filter((n) => n.endsWith(stamp)).length, 0);

  // Confirmed: this video's copy and the take in Recordings go to the trash; the other video keeps its own copy.
  d = await call('own', '/rec-delete', { take: stamp, confirm: true });
  assert.equal(d.code, 200, JSON.stringify(d.body));
  assert.equal(d.body.ok, true);
  assert.ok(!existsSync(join(recordings, stamp)));
  assert.ok(!existsSync(join(pdir, 'source', `${stamp}_webcam.mp4`)));
  assert.ok(existsSync(join(odir, 'source', `${stamp}_webcam.mp4`)), 'the other video keeps its copy');
  assert.ok(existsSync(join(pdir, 'work', 'edl_manual.json')), 'the work stays in the project');
  assert.equal(readJ(join(pdir, 'project.json')).activeTake, undefined);
  assert.equal((await call('own', '/rec-restore', { trash: d.body.trash })).code, 200);
  assert.ok(existsSync(join(recordings, stamp, `${stamp}_webcam.mp4`)), 'Undo brings it back');
  rmSync(join(projects, 'other'), { recursive: true, force: true });

  // A take still recording can't be deleted (Restart is the way to drop it).
  project('live');
  const live = (await start('live')).body.take;
  d = await call('live', '/rec-delete', { take: live });
  assert.equal(d.code, 409);
  assert.match(d.body.error, /still recording/);
  await call('live', '/rec-discard', { take: live });

  // Another project's take, and names that aren't takes or trash entries.
  assert.equal((await call('live', '/rec-delete', { take: stamp })).code, 400);
  assert.equal((await call('own', '/rec-delete', { take: '../projects' })).code, 400);
  assert.equal((await call('own', '/rec-restore', { trash: '../../etc' })).code, 400);
});

test('a take that never made it into a project can be deleted on its own, and restored', async () => {
  const stamp = '2026-10-24_13-00-00';
  project('lone');
  const dir = join(recordings, stamp);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${stamp}_audio.wav`), 'wav');
  writeJ(join(dir, 'take.json'), { recorder: 'browser', project: 'lone', finished: Date.now(), tracks: {} });
  const d = await call('lone', '/rec-delete', { take: stamp });
  assert.equal(d.code, 200, JSON.stringify(d.body));
  assert.equal(d.body.project, null);
  assert.equal(existsSync(dir), false);
  assert.equal((await call('lone', '/rec-restore', { trash: d.body.trash })).code, 200);
  assert.ok(existsSync(join(dir, `${stamp}_audio.wav`)));
});

// ---- the web side, statically ----
const web = (f) => readFileSync(new URL(`../web/${f}`, import.meta.url), 'utf8');

test('recorder.css uses theme tokens, not hex colours, and both pages link it', () => {
  const css = web('recorder.css').replace(/\/\*[\s\S]*?\*\//g, '');
  const hex = [...css.matchAll(/[{;]\s*(--?[\w-]+|[a-z-]+)\s*:([^;{}]*)/gi)].flatMap((m) => [...m[2].matchAll(/#[0-9a-f]{3,8}\b/gi)].map((x) => `${m[1]}: ${x[0]}`));
  assert.deepEqual(hex, []);
  assert.match(web('index.html'), /<link rel="stylesheet" href="\/recorder.css">/);
  assert.match(web('prompter.html'), /<link rel="stylesheet" href="recorder.css">/);
});

test('every prompter key has a button, and the keys still work', () => {
  const js = web('prompter.js');
  for (const a of ['toggle', 'faster', 'slower', 'bigger', 'smaller', 'back', 'forward', 'toStart', 'mirror', 'fullscreen']) {
    assert.match(js, new RegExp(`data-p="${a}"`), `a button for ${a}`);
  }
  for (const k of [`k === ' '`, `'ArrowUp'`, `'ArrowDown'`, `'ArrowLeft'`, `'ArrowRight'`, `k === '+'`, `k === '-'`, `'r' || k === 'R'`, `'m' || k === 'M'`, `'f' || k === 'F'`]) {
    assert.ok(js.includes(k), `key ${k}`);
  }
  assert.doesNotMatch(js, /class="pp-keys"/, 'the key hint became buttons');
  assert.match(web('prompter.html'), /prompterControls\(p\)/, 'the script window has them too');
});

test('pause and restart keys are new combinations with their keys in the tooltips', () => {
  const js = web('recorder.js');
  assert.match(js, /PAUSE_KEY = isMac \? '⌥⌘P' : 'Ctrl\+Alt\+P'/);
  assert.match(js, /RESTART_KEY = isMac \? '⇧⌥⌘R' : 'Ctrl\+Alt\+Shift\+R'/);
  // The Record key is ⌥⌘R without Shift, so Restart (with Shift) never reaches it.
  assert.match(js, /isHotkey = \(e\) => e.code === 'KeyR' && e.altKey && !e.shiftKey/);
  assert.match(js, /\(\$\{PAUSE_KEY\}\)/);
  assert.match(js, /\(\$\{RESTART_KEY\}\)/);
  // No other part of the app listens for P with ⌥ and ⌘/Ctrl.
  for (const f of readdirSync(new URL('../web/', import.meta.url)).filter((n) => n.endsWith('.js') && n !== 'recorder.js')) {
    assert.doesNotMatch(web(f), /KeyP/, f);
  }
});
