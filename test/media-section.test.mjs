// The editor's Media section on the server side (server/media.mjs): the list of what a video uses, Use an older take,
// Add as a layer, Remove / Delete recording to the studio's trash with an Undo that puts everything back exactly, and
// the refusals (work made from the recording, a block's file, Claude or an export busy). Plus the layer order and
// visibility the canvas saves in project.json, the upload-as-a-layer path and static checks of the web side.
// A throwaway studio and settings folder; synthetic bytes stand in for video (nothing is probed or played).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync, rmSync, utimesSync } from 'node:fs';
import { Readable } from 'node:stream';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const tmp = mkdtempSync(join(tmpdir(), 'vo-media-'));
const studio = join(tmp, 'studio');
const projects = join(studio, 'projects');
process.env.STUDIO_LOCAL_DIR = join(tmp, 'local');
mkdirSync(process.env.STUDIO_LOCAL_DIR, { recursive: true });
writeFileSync(join(process.env.STUDIO_LOCAL_DIR, 'settings.json'), JSON.stringify({ studio }));
mkdirSync(join(studio, 'recordings'), { recursive: true });

let media, studioMod, layoutMod;
before(async () => {
  media = await import('../server/media.mjs');
  studioMod = await import('../server/studio.mjs');
  layoutMod = await import('../web/layout.js');
});
after(() => rmSync(tmp, { recursive: true, force: true }));

const readJ = (p) => JSON.parse(readFileSync(p, 'utf8'));
const writeJ = (p, v) => { mkdirSync(join(p, '..'), { recursive: true }); writeFileSync(p, JSON.stringify(v, null, 2)); };
const trash = () => join(studio, '.trash');
const trashEntries = () => (existsSync(trash()) ? readdirSync(trash()) : []);
const HOUR_AGO = (Date.now() - 3600e3) / 1000;

const A = '2026-10-20_09-00-00', B = '2026-10-24_10-00-00', B2 = '2026-10-24_10-00-00-2';
// A project: take A (older, screen + camera), take B (the canvas take, screen + camera), B-2 (a take whose stamp
// starts with B's), clip.mp4 (imported, an extra layer), voice_audio.wav (a block's file), with playback copies.
function project(id, extra = {}) {
  const dir = join(projects, id);
  for (const d of ['source', 'work', 'renders']) mkdirSync(join(dir, d), { recursive: true });
  const files = [`${A}_screen.mp4`, `${A}_webcam.mp4`, `${B}_screen.mp4`, `${B}_webcam.mp4`, `${B2}_webcam.mp4`, 'clip.mp4', 'voice_audio.wav'];
  for (const f of files) {
    writeFileSync(join(dir, 'source', f), `bytes of ${f}`);
    utimesSync(join(dir, 'source', f), HOUR_AGO, HOUR_AGO);
    if (!f.endsWith('.wav')) writeFileSync(join(dir, studioMod.proxyName(f)), `proxy of ${f}`);
  }
  const layout = layoutMod.normalize({ ...layoutMod.defaultLayout('tutorial'), layers: [
    { id: 'Lclip', file: 'clip.mp4', kind: 'cam', x: 0.7, y: 0.1, w: 0.2, shape: 'rounded', zoom: 1, audio: true },
  ] }, 'tutorial');
  writeJ(join(dir, 'project.json'), { name: id.toUpperCase(), type: 'tutorial', takes: [A, B, B2], activeTake: B, layout, ...extra });
  writeJ(join(dir, 'work', 'blocks.json'), { blocks: [{ id: 'vo', type: 'custom', label: 'Voiceover', source: { file: 'source/voice_audio.wav' } }] });
  return dir;
}
const meta = (dir) => readJ(join(dir, 'project.json'));
const sourceFiles = (dir) => readdirSync(join(dir, 'source')).sort();

// One route call, the way server/index.mjs makes it.
async function call(dir, action, payload = {}, { method = 'POST', busy = null } = {}) {
  let out = null;
  const events = [];
  const answered = await media.mediaRoute({ method }, {}, {
    dir, action,
    send: (_res, code, body) => { out = { code, body }; },
    body: async () => payload,
    emit: (ev) => events.push(ev),
    busy: () => busy,
  });
  assert.equal(answered, true);
  return { ...out, events };
}

test('takeKey groups the recorder’s files by take and names imported files by themselves', () => {
  assert.equal(studioMod.takeKey(`${B}_screen.mp4`), B);
  assert.equal(studioMod.takeKey(`${B2}_webcam.mov`), B2);
  assert.equal(studioMod.takeKey(`${B}_audio.wav`), B);
  assert.equal(studioMod.takeKey('clip (2).mp4'), 'clip (2)');
  assert.equal(studioMod.takeKey('voice_audio.m4a'), 'voice');
  assert.equal(studioMod.takeKey('notes_screen.mp3'), 'notes_screen');
});

test('the list has every take and file, where each is used, the canvas take first', async () => {
  const dir = project('list');
  const r = await call(dir, '/media-items', null, { method: 'GET' });
  assert.equal(r.code, 200);
  const ids = r.body.items.map((x) => x.id);
  assert.equal(ids[0], B, 'the canvas take comes first');
  assert.equal(ids[1], 'clip', 'then the layers');
  assert.deepEqual([...ids].sort(), [A, B, B2, 'clip', 'voice'].sort());
  const by = Object.fromEntries(r.body.items.map((x) => [x.id, x]));
  assert.equal(by[B].canvas, true);
  assert.deepEqual(by[B].files.map((f) => f.file), [`${B}_screen.mp4`, `${B}_webcam.mp4`], 'B-2 is a take of its own, not part of B');
  assert.deepEqual(by[B].files.map((f) => f.role), ['screen', 'camera']);
  assert.equal(by[B2].canvas, false);
  assert.deepEqual(by.clip.layers, [{ id: 'Lclip', file: 'clip.mp4', hidden: false }]);
  assert.equal(by.clip.recorded, false);
  assert.equal(by[A].recorded, true);
  assert.deepEqual(by.voice.blocks, [{ id: 'vo', label: 'Voiceover' }]);
  assert.equal(by.voice.take, true);
  assert.equal(by.voice.picture, false);
  assert.ok(by[A].files.every((f) => f.proxy), 'playback copies are found');
  assert.deepEqual(r.body.work, []);
  assert.deepEqual(r.body.removed, []);
  // roles() follows the same grouping: the canvas take is exactly B's files.
  assert.deepEqual(studioMod.roles(dir).take, [`${B}_screen.mp4`, `${B}_webcam.mp4`]);
});

test('Use an older take puts it on the canvas; work on the current take is asked about first', async () => {
  const dir = project('use');
  const r = await call(dir, '/media-use', { item: A });
  assert.equal(r.code, 200, JSON.stringify(r.body));
  assert.equal(meta(dir).activeTake, A);
  assert.ok(meta(dir).activeSince > Date.now() - 5000, 'cuts made for the other take no longer count');
  assert.equal(studioMod.roles(dir).webcam, `${A}_webcam.mp4`);
  assert.ok(r.events.some((e) => e.t === 'files'));
  assert.equal((await call(dir, '/media-use', { item: A })).code, 409, 'already on the canvas');

  // B gets a transcript and a cut while it's on the canvas: switching away asks first.
  await call(dir, '/media-use', { item: B });
  writeJ(join(dir, 'work', 'tr', 'words.json'), { words: [] });
  writeJ(join(dir, 'work', 'edl_manual.json'), { segments_sec: [[0, 1]] });
  const future = Date.now() / 1000 + 120;
  utimesSync(join(dir, 'work', 'tr', 'words.json'), future, future);
  utimesSync(join(dir, 'work', 'edl_manual.json'), future, future);
  const ask = await call(dir, '/media-use', { item: A });
  assert.equal(ask.code, 409);
  assert.equal(ask.body.ok, false);
  assert.match(ask.body.confirm, /a transcript and a cut/);
  assert.equal(meta(dir).activeTake, B, 'nothing changed before the answer');
  const yes = await call(dir, '/media-use', { item: A, confirm: true });
  assert.equal(yes.code, 200);
  assert.equal(meta(dir).activeTake, A);
  assert.ok(existsSync(join(dir, 'work', 'tr', 'words.json')), 'the transcript stays in work/');

  // A layer used as the recording leaves the layers (it doesn't show twice); a sound file can't be the recording.
  assert.equal((await call(dir, '/media-use', { item: 'clip', confirm: true })).code, 200);
  assert.deepEqual(meta(dir).layout.layers, []);
  assert.equal(studioMod.roles(dir).main, 'clip.mp4');
  writeFileSync(join(dir, 'source', 'music.mp3'), 'music');
  const snd = await call(dir, '/media-use', { item: 'music' });
  assert.equal(snd.code, 409);
  assert.match(snd.body.error, /sound file/);
});

test('Remove moves a layer’s files to the trash; Undo restores project.json and the files exactly', async () => {
  const dir = project('rm');
  // clip.mp4 counts as a take of this project here (a recordings-folder take), so it goes to the trash; an imported
  // file is parked in the recordings folder instead (test/imports-recordings.test.mjs).
  writeJ(join(dir, 'project.json'), { ...meta(dir), takes: [A, B, B2, 'clip'] });
  const before = meta(dir), files = sourceFiles(dir);
  const r = await call(dir, '/media-remove', { item: 'clip' });
  assert.equal(r.code, 200, JSON.stringify(r.body));
  assert.equal(existsSync(join(dir, 'source', 'clip.mp4')), false);
  assert.equal(existsSync(join(dir, 'work', 'proxy_clip.mp4')), false);
  const entry = join(trash(), r.body.trash);
  assert.equal(readFileSync(join(entry, 'project', 'source', 'clip.mp4'), 'utf8'), 'bytes of clip.mp4', 'nothing is deleted');
  assert.ok(existsSync(join(entry, 'project', 'work', 'proxy_clip.mp4')));
  const m = readJ(join(entry, 'manifest.json'));
  assert.equal(m.kind, 'media-removed');
  assert.equal(m.project, 'rm');
  assert.deepEqual(m.files, ['clip.mp4']);
  assert.deepEqual(meta(dir).layout.layers, [], 'its layer is off the canvas');
  assert.equal(meta(dir).activeTake, B, 'the canvas take is unchanged');
  assert.match(readFileSync(join(dir, 'WORKLOG.md'), 'utf8'), /Removed clip from the video \(Media\)/);
  const list = await call(dir, '/media-items', null, { method: 'GET' });
  assert.deepEqual(list.body.removed.map((x) => [x.trash, x.item]), [[r.body.trash, 'clip']], 'Recently removed offers it back');

  const u = await call(dir, '/media-restore', { trash: r.body.trash });
  assert.equal(u.code, 200, JSON.stringify(u.body));
  assert.deepEqual(meta(dir), before, 'project.json is exactly as before');
  assert.deepEqual(sourceFiles(dir), files);
  assert.equal(readFileSync(join(dir, 'work', 'proxy_clip.mp4'), 'utf8'), 'proxy of clip.mp4');
  assert.equal(existsSync(entry), false, 'the empty trash entry goes');
  assert.equal((await call(dir, '/media-restore', { trash: r.body.trash })).code, 400, 'an Undo only works once');
});

test('Delete recording: the canvas falls back to the previous take; Undo brings the recording back on the canvas', async () => {
  const dir = project('del', { takes: [A, B], activeTake: B });
  const before = meta(dir);
  const r = await call(dir, '/media-remove', { item: B });
  assert.equal(r.code, 200, JSON.stringify(r.body));
  assert.equal(r.body.canvas, true);
  assert.equal(r.body.activeTake, A);
  assert.equal(meta(dir).activeTake, A);
  assert.deepEqual(meta(dir).takes, [A]);
  assert.equal(studioMod.roles(dir).webcam, `${A}_webcam.mp4`);
  assert.ok(!sourceFiles(dir).some((f) => f.startsWith(`${B}_`)));
  assert.ok(sourceFiles(dir).includes(`${B2}_webcam.mp4`), 'the take whose name starts the same stays');

  const u = await call(dir, '/media-restore', { trash: r.body.trash });
  assert.equal(u.code, 200);
  assert.deepEqual(meta(dir), before);
  assert.equal(studioMod.roles(dir).webcam, `${B}_webcam.mp4`);
});

test('Delete recording prefers a take that isn’t a layer; a layer that becomes the recording leaves the layers', async () => {
  const dir = project('fall', { takes: [A, B], activeTake: B });
  // Without A and B-2 the only other take is clip, a layer.
  for (const f of [`${A}_screen.mp4`, `${A}_webcam.mp4`, `${B2}_webcam.mp4`]) rmSync(join(dir, 'source', f));
  const before = meta(dir);
  const r = await call(dir, '/media-remove', { item: B });
  assert.equal(r.code, 200, JSON.stringify(r.body));
  assert.equal(meta(dir).activeTake, 'clip');
  assert.deepEqual(meta(dir).layout.layers, [], 'clip is the recording now, not also a layer');
  await call(dir, '/media-restore', { trash: r.body.trash });
  assert.deepEqual(meta(dir), before);
});

test('Deleting the only recording leaves an empty video (the start screen); Undo brings it back', async () => {
  const dir = join(projects, 'only');
  mkdirSync(join(dir, 'source'), { recursive: true });
  writeFileSync(join(dir, 'source', `${B}_webcam.mp4`), 'cam');
  mkdirSync(join(dir, 'work'), { recursive: true });
  writeFileSync(join(dir, studioMod.proxyName(`${B}_webcam.mp4`)), 'proxy');
  writeJ(join(dir, 'project.json'), { name: 'Only', type: 'tutorial', takes: [B], activeTake: B, activeSince: 123 });
  const before = meta(dir);
  const r = await call(dir, '/media-remove', { item: B });
  assert.equal(r.code, 200, JSON.stringify(r.body));
  assert.equal(r.body.activeTake, null);
  assert.equal('activeTake' in meta(dir), false);
  assert.deepEqual(studioMod.roles(dir).files, [], 'no take: the editor shows How do you want to start?');
  await call(dir, '/media-restore', { trash: r.body.trash });
  assert.deepEqual(meta(dir), before);
});

test('the canvas take with a transcript, cut, scene plan or render is refused, as is a block’s file', async () => {
  const dir = project('refuse');
  const future = Date.now() / 1000 + 120;
  mkdirSync(join(dir, 'work', 'tr'), { recursive: true });
  for (const [file, word] of [['work/tr/words.json', 'a transcript'], ['work/edl_fixed.json', 'a cut'], ['work/production.json', 'a scene plan'], ['renders/v1.mp4', 'renders']]) {
    writeFileSync(join(dir, file), '{}');
    utimesSync(join(dir, file), future, future);
    const r = await call(dir, '/media-remove', { item: B });
    assert.equal(r.code, 409, file);
    assert.match(r.body.error, new RegExp(`already has .*${word}`), file);
    assert.match(r.body.error, /Put another take on the canvas first/);
    rmSync(join(dir, file));
  }
  const blk = await call(dir, '/media-remove', { item: 'voice' });
  assert.equal(blk.code, 409);
  assert.match(blk.body.error, /file of the “Voiceover” block/);
  assert.deepEqual(trashEntries().filter((n) => n.endsWith('-voice')), [], 'nothing moved');
  assert.ok(existsSync(join(dir, 'source', `${B}_webcam.mp4`)));

  // A render made while a layer was in the video: asked first, the render stays.
  writeFileSync(join(dir, 'renders', 'v2.mp4'), 'render');
  const ask = await call(dir, '/media-remove', { item: 'clip' });
  assert.equal(ask.code, 409);
  assert.match(ask.body.confirm, /A render was made while “clip” was in this video/);
  assert.ok(existsSync(join(dir, 'source', 'clip.mp4')));
  const yes = await call(dir, '/media-remove', { item: 'clip', confirm: true });
  assert.equal(yes.code, 200);
  assert.ok(existsSync(join(dir, 'renders', 'v2.mp4')), 'renders are never touched');
});

test('nothing moves or switches while Claude, an export or a playback copy uses the files', async () => {
  const dir = project('busy');
  const before = meta(dir), files = sourceFiles(dir);
  for (const [action, payload] of [['/media-remove', { item: A }], ['/media-use', { item: A }], ['/media-layer', { item: A }]]) {
    const r = await call(dir, action, payload, { busy: 'An export is running for this project: wait for it to finish, or stop it.' });
    assert.equal(r.code, 409, action);
    assert.match(r.body.error, /export is running/);
  }
  assert.deepEqual(meta(dir), before);
  assert.deepEqual(sourceFiles(dir), files);

  // A playback copy being made: its file can't move until it's done. (makeProxies marks it running as it spawns
  // ffmpeg; the synthetic bytes make ffmpeg give up a moment later, after this check.)
  rmSync(join(dir, 'work', `proxy_${A}_webcam.mp4`));
  studioMod.makeProxies(dir, () => {});
  assert.equal(studioMod.proxyRunning(dir, [`${A}_webcam.mp4`]), true);
  const r = await call(dir, '/media-remove', { item: A });
  assert.equal(r.code, 409);
  assert.match(r.body.error, /playback copy/);
  assert.ok(existsSync(join(dir, 'source', `${A}_webcam.mp4`)));
});

test('Add as a layer puts an unused take on top; at most 8 layers', async () => {
  const dir = project('layer');
  const r = await call(dir, '/media-layer', { item: A });
  assert.equal(r.code, 200, JSON.stringify(r.body));
  const layers = meta(dir).layout.layers;
  assert.deepEqual(layers.map((x) => x.file), ['clip.mp4', `${A}_screen.mp4`, `${A}_webcam.mp4`], 'new layers go on top');
  assert.deepEqual(layers.slice(1).map((x) => x.kind), ['screen', 'cam']);
  assert.equal(meta(dir).activeTake, B);
  assert.equal((await call(dir, '/media-layer', { item: A })).code, 409, 'a layer already');
  assert.equal((await call(dir, '/media-layer', { item: B })).code, 409, 'the canvas take');
  assert.match((await call(dir, '/media-layer', { item: 'voice' })).body.error, /no picture/);
  const full = meta(dir);
  full.layout.layers = Array.from({ length: 8 }, (_, i) => ({ ...layers[0], id: `L${i}` }));
  writeJ(join(dir, 'project.json'), full);
  assert.match((await call(dir, '/media-layer', { item: B2 })).body.error, /at most 8 layers/);
});

test('layer order and visibility are kept in project.json layout, as the canvas saves them', () => {
  const dir = project('order');
  const L = layoutMod;
  const base = L.normalize(meta(dir).layout, 'tutorial');
  base.layers = [...base.layers, ...L.newLayers(base, [`${A}_screen.mp4`, `${A}_webcam.mp4`], {})];
  const [clip, scr, cam] = base.layers.map((x) => x.id);
  // Drag the clip to the top (the last index is drawn on top), ↓ on the camera moves it one down.
  let layers = L.moveLayer(base.layers, clip, 2);
  assert.deepEqual(layers.map((x) => x.id), [scr, cam, clip]);
  layers = L.moveLayer(layers, cam, 0);
  assert.deepEqual(layers.map((x) => x.id), [cam, scr, clip]);
  assert.deepEqual(L.moveLayer(layers, 'nope', 0).map((x) => x.id), [cam, scr, clip], 'an unknown id changes nothing');
  assert.deepEqual(L.moveLayer(layers, cam, 99).map((x) => x.id), [scr, clip, cam], 'clamped to the top');
  layers[1].hidden = true;
  // The canvas saves the layout whole (POST /layout normalizes it into project.json): order and hidden survive.
  studioMod.saveProjectMeta(dir, { layout: L.normalize({ ...base, layers }, 'tutorial') });
  const saved = L.normalize(meta(dir).layout, 'tutorial');
  assert.deepEqual(saved.layers.map((x) => x.id), [cam, scr, clip]);
  assert.equal(saved.layers[1].hidden, true);
  assert.equal(saved.layers[0].hidden, undefined);
  // The picture and every export draw them in that order and leave the hidden one out.
  const dims = { cam: [1920, 1080], screen: [1920, 1080], files: { [`${A}_screen.mp4`]: [1920, 1080], [`${A}_webcam.mp4`]: [1280, 720], 'clip.mp4': [1280, 720] } };
  const refs = L.compose(saved, dims).layers.map((x) => x.ref).filter((x) => x.startsWith('layer:'));
  assert.deepEqual(refs, [`layer:${cam}`, `layer:${clip}`]);
});

test('an uploaded video can come in as a layer: the canvas take stays', async () => {
  const dir = project('upload');
  const files = await studioMod.importUpload(dir, Readable.from([Buffer.from('a video')]), 'overlay.mp4', { keepActive: true });
  assert.deepEqual(files, ['overlay.mp4']);
  assert.equal(meta(dir).activeTake, B);
  assert.equal(studioMod.roles(dir).webcam, `${B}_webcam.mp4`);
  assert.match(readFileSync(join(dir, 'WORKLOG.md'), 'utf8'), /Imported overlay.mp4 as a new layer/);
});

test('a dropped screen recording becomes the take’s screen, not a camera; another video stays as it is', async () => {
  const dir = project('dropped');
  const files = await studioMod.importUpload(dir, Readable.from([Buffer.from('a video')]), 'Screen Recording 2026-10-24 at 10.02.11.mov');
  assert.deepEqual(files, ['Screen Recording 2026-10-24 at 10.02.11_screen.mov']);
  const r = studioMod.roles(dir);
  assert.equal(r.screen, files[0]);
  assert.equal(r.webcam, null);
  assert.equal(meta(dir).activeTake, 'Screen Recording 2026-10-24 at 10.02.11');
  const other = project('dropped-clip');
  assert.deepEqual(await studioMod.importUpload(other, Readable.from([Buffer.from('a video')]), 'my clip.mov'), ['my clip.mov']);
  assert.equal(studioMod.roles(other).screen, null);
});

test('the web side: media.css uses tokens and is linked; the editor has Delete recording and the Media menu', () => {
  const web = (f) => readFileSync(new URL(`../web/${f}`, import.meta.url), 'utf8');
  const css = web('media.css').replace(/\/\*[\s\S]*?\*\//g, '');
  assert.doesNotMatch(css, /#[0-9a-f]{3,8}\b/i);
  assert.match(web('index.html'), /<link rel="stylesheet" href="\/media.css">/);
  const js = web('media.js'), app = web('app.js');
  assert.match(js, /Delete recording/);
  assert.match(js, /\/media-remove/);
  assert.match(js, /\/media-restore/);
  assert.match(app, /id="mediaTool"/);
  assert.match(app, /id="mediaSec"/);
  assert.match(app, /wireReorder\(/);
});
