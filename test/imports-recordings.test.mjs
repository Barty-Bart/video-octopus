// A17: files dropped or imported into a video show in Recordings, listed where they are (the video's source/), never
// copied a second time, named after the original file and marked Imported (server/media.mjs importedRecordings).
// - Older imports: the WORKLOG line names the original file; otherwise the file's own name. Takes, library copies and
//   takes from another recorder's folder are not imports.
// - Remove from this video keeps the file: it moves (same inode) to the recordings folder with import.json, so
//   Recordings still lists it, once; Undo moves it back.
// - Delete recording sends it to the Bin: out of the video and out of Recordings.
// - Start a video from it (a parked import) moves the file into the new video; it is never in two places.
// - Refused while the video is busy.
// A throwaway studio, settings folder and fake Bin; synthetic bytes stand in for video. No file names with * " or :.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync, rmSync, renameSync, statSync } from 'node:fs';
import { Readable } from 'node:stream';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const tmp = mkdtempSync(join(tmpdir(), 'vo-imports-'));
const studio = join(tmp, 'studio');
const recordings = join(studio, 'recordings');
const projects = join(studio, 'projects');
const fakeBin = join(tmp, 'fake-bin');
process.env.STUDIO_LOCAL_DIR = join(tmp, 'local');
delete process.env.OCTOPUS_FAKE_BIN;
for (const d of [process.env.STUDIO_LOCAL_DIR, recordings, projects, fakeBin]) mkdirSync(d, { recursive: true });
writeFileSync(join(process.env.STUDIO_LOCAL_DIR, 'settings.json'), JSON.stringify({ studio }));

let media, studioMod, trashMod, bin;
before(async () => {
  media = await import('../server/media.mjs');
  studioMod = await import('../server/studio.mjs');
  trashMod = await import('../server/trash.mjs');
  bin = await import('../server/os-trash.mjs');
});
after(() => { bin.setBinMover(null); rmSync(tmp, { recursive: true, force: true }); });

const readJ = (p) => JSON.parse(readFileSync(p, 'utf8'));
const writeJ = (p, v) => { mkdirSync(join(p, '..'), { recursive: true }); writeFileSync(p, JSON.stringify(v, null, 2)); };
const trash = () => join(studio, '.trash');
const toBin = async (entry) => {
  const from = join(trash(), entry), to = join(fakeBin, entry);
  renameSync(from, to);
  return { where: 'the Trash', how: 'fake', putBack: true, undo: bin.rememberUndo({ path: to }, from) };
};
function project(id, { takes = [], extra = {} } = {}) {
  const dir = join(projects, id);
  for (const d of ['source', 'work', 'renders']) mkdirSync(join(dir, d), { recursive: true });
  for (const t of takes) writeFileSync(join(dir, 'source', `${t}_webcam.mp4`), `copy of ${t}`);
  writeJ(join(dir, 'project.json'), { name: id.toUpperCase(), type: 'tutorial', takes, ...(takes.length ? { activeTake: takes.at(-1) } : {}), ...extra });
  return dir;
}
const upload = (dir, name, opts) => studioMod.importUpload(dir, Readable.from([Buffer.from(`bytes of ${name}`)]), name, opts);
async function mediaCall(dir, action, payload, { busy = null } = {}) {
  let out = null;
  await media.mediaRoute({ method: 'POST' }, {}, { dir, action, send: (_r, code, body) => { out = { code, body }; }, body: async () => payload, emit: () => {}, busy: () => busy, toBin });
  return out;
}
async function trashCall(path, payload) {
  let out = null;
  await trashMod.trashRoute({ method: 'POST' }, {}, new URL(`http://127.0.0.1${path}`), { send: (_r, code, body) => { out = { code, body }; }, body: async () => payload, toBin });
  return out;
}
const listed = (project) => media.importedRecordings().filter((x) => x.project === project);
// Every file in the studio (and the fake Bin) with these bytes: one means no second copy anywhere.
function copiesOf(text) {
  const out = [];
  const walk = (d) => { for (const e of readdirSync(d, { withFileTypes: true })) { const p = join(d, e.name); if (e.isDirectory()) walk(p); else if (readFileSync(p, 'utf8') === text) out.push(p); } };
  walk(tmp);
  return out;
}

test('a dropped file is listed where it is, named after the original file, marked Imported, with its video', async () => {
  const dir = project('drop');
  const [file] = await upload(dir, 'Screen Recording 2026-10-24 at 10.02.11.mov');
  assert.equal(file, 'Screen Recording 2026-10-24 at 10.02.11_screen.mov');
  const meta = readJ(join(dir, 'project.json'));
  assert.equal(meta.imports['Screen Recording 2026-10-24 at 10.02.11'].name, 'Screen Recording 2026-10-24 at 10.02.11.mov');
  const [row] = listed('drop');
  assert.equal(row.name, 'Screen Recording 2026-10-24 at 10.02.11.mov');
  assert.equal(row.imported, true);
  assert.equal(row.inVideo, true);
  assert.deepEqual(row.files, [file]);
  assert.deepEqual(row.projects, ['DROP']);
  assert.equal(row.item, 'Screen Recording 2026-10-24 at 10.02.11');
  // No second copy: the recordings folder is untouched and the bytes exist once, in source/.
  assert.deepEqual(readdirSync(recordings), []);
  assert.deepEqual(copiesOf('bytes of Screen Recording 2026-10-24 at 10.02.11.mov'), [join(dir, 'source', file)]);
  assert.equal(existsSync(join(studio, '.studio', 'files')), false, 'nothing went into the file store');
  // The Media section says it is in Recordings, and names it.
  const item = media.mediaItems(dir).items.find((x) => x.id === row.item);
  assert.equal(item.inRecordings, true);
  assert.equal(item.name, row.name);
  // A layer import is listed too.
  await upload(dir, 'overlay.MP4', { keepActive: true });
  assert.deepEqual(listed('drop').map((x) => x.name).sort(), ['Screen Recording 2026-10-24 at 10.02.11.mov', 'overlay.MP4']);
});

test('older imports: the WORKLOG names the original file, else the file’s own name; takes and library copies are not imports', () => {
  const S = '2026-10-22_09-00-00';
  mkdirSync(join(recordings, 'Other recorder'), { recursive: true });
  writeFileSync(join(recordings, 'Other recorder', 'cam.mov'), 'cam');
  const dir = project('old', { takes: [S, 'Other recorder'] });
  for (const f of ['My clip_ (2).mp4', 'plain.mov', 'b-roll.mp4', 'cam.mov', 'voice.m4a']) writeFileSync(join(dir, 'source', f), f);
  writeFileSync(join(dir, 'WORKLOG.md'), '# Worklog\r\n- 2026-09-01: Imported My clip? (2).mp4 as the take: source/My clip_ (2).mp4\r\n'
    + '- 2026-09-02: Copied library/b-roll.mp4 from the library into source/b-roll.mp4 for a block\r\n'
    + '- 2026-09-03: Imported take Other recorder: cam.mov\r\n');
  const rows = listed('old').sort((a, b) => a.name.localeCompare(b.name));
  assert.deepEqual(rows.map((x) => [x.item, x.name]), [['My clip_ (2)', 'My clip? (2).mp4'], ['plain', 'plain.mov']]);
  // The recorder take, the library copy, the other recorder's take and a loose sound file stay out.
  assert.equal(media.importName(S, [`${S}_webcam.mp4`], { takes: [S] }), null);
  assert.equal(media.importName('voice', ['voice.m4a'], {}), null);
});

test('Remove from this video keeps the file: it moves to Recordings (same inode), listed once; Undo moves it back', async () => {
  const S = '2026-10-23_09-00-00';
  mkdirSync(join(recordings, S), { recursive: true });
  writeFileSync(join(recordings, S, `${S}_webcam.mp4`), 'take');
  const dir = project('park', { takes: [S] });
  const [file] = await upload(dir, 'talk.mov');
  writeFileSync(join(dir, studioMod.proxyName(file)), 'proxy');
  const ino = statSync(join(dir, 'source', file)).ino;
  const before = readJ(join(dir, 'project.json'));
  assert.equal(before.activeTake, 'talk');

  const r = await mediaCall(dir, '/media-remove', { item: 'talk' });
  assert.equal(r.code, 200, JSON.stringify(r.body));
  assert.equal(r.body.parked, 'talk');
  assert.equal(r.body.recordings, false);
  assert.equal(existsSync(join(dir, 'source', file)), false);
  const parked = join(recordings, 'talk', 'talk.mov');
  assert.equal(statSync(parked).ino, ino, 'the same file, moved, not copied');
  assert.deepEqual(copiesOf('bytes of talk.mov'), [parked]);
  assert.equal(readJ(join(recordings, 'talk', 'import.json')).name, 'talk.mov');
  assert.equal(readJ(join(dir, 'project.json')).activeTake, S, 'the canvas goes back to the take before');
  // Recordings: once, as a take folder marked Imported with the original name; not as the video's import any more.
  assert.deepEqual(listed('park'), []);
  const t = studioMod.listTakes().find((x) => x.id === 'talk');
  assert.equal(t.imported, true);
  assert.equal(t.name, 'talk.mov');
  assert.equal(t.used, false);
  assert.match(readFileSync(join(dir, 'WORKLOG.md'), 'utf8'), /Removed talk from the video \(Media\): talk\.mov moved to Recordings/);
  assert.match(trashMod.trashView().items.find((x) => x.trash === r.body.trash).what, /the file waits in Recordings/);

  const u = await mediaCall(dir, '/media-restore', { trash: r.body.trash });
  assert.equal(u.code, 200, JSON.stringify(u.body));
  assert.equal(statSync(join(dir, 'source', file)).ino, ino);
  assert.equal(existsSync(join(recordings, 'talk')), false, 'the folder in Recordings goes');
  assert.deepEqual(readJ(join(dir, 'project.json')), before);
  assert.equal(listed('park').length, 1);
});

test('a parked file whose name is taken in Recordings gets its own folder, and its files are named after it', async () => {
  mkdirSync(join(recordings, 'intro'), { recursive: true });
  writeFileSync(join(recordings, 'intro', 'intro.mp4'), 'someone else’s take');
  const dir = project('clash');
  await upload(dir, 'intro.mp4');
  const r = await mediaCall(dir, '/media-remove', { item: 'intro' });
  assert.equal(r.body.parked, 'intro (2)');
  assert.ok(existsSync(join(recordings, 'intro (2)', 'intro (2).mp4')));
  assert.equal(studioMod.listTakes().find((x) => x.id === 'intro (2)').name, 'intro.mp4');
});

test('Start a video from a parked import moves the file in: one item, never in two places', async () => {
  const dir = project('from');
  await upload(dir, 'demo.mp4');
  await mediaCall(dir, '/media-remove', { item: 'demo' });
  const ino = statSync(join(recordings, 'demo', 'demo.mp4')).ino;
  const next = project('next');
  studioMod.importTake(next, 'demo');
  assert.equal(statSync(join(next, 'source', 'demo.mp4')).ino, ino, 'moved, not cloned');
  assert.equal(existsSync(join(recordings, 'demo')), false);
  const m = readJ(join(next, 'project.json'));
  assert.deepEqual(m.takes, []);
  assert.equal(m.imports.demo.name, 'demo.mp4');
  assert.equal(m.activeTake, 'demo');
  assert.equal(studioMod.roles(next).main, 'demo.mp4');
  assert.deepEqual(listed('next').map((x) => x.name), ['demo.mp4']);
  assert.ok(!studioMod.listTakes().some((x) => x.id === 'demo'));
  assert.deepEqual(copiesOf('bytes of demo.mp4'), [join(next, 'source', 'demo.mp4')]);
  // The first video's Undo can't bring it back now: it says why.
  const removed = media.mediaItems(dir).removed[0];
  const u = await mediaCall(dir, '/media-restore', { trash: removed.trash });
  assert.equal(u.code, 400);
  assert.match(u.body.error, /isn’t in Recordings any more/);
});

test('Delete recording sends an imported file to the Bin: out of the video and out of Recordings', async () => {
  const dir = project('gone');
  const [file] = await upload(dir, 'final cut.mov');
  const r = await mediaCall(dir, '/media-delete', { item: 'final cut' });
  assert.equal(r.code, 200, JSON.stringify(r.body));
  assert.equal(r.body.recordings, true);
  assert.deepEqual(r.body.others, []);
  assert.equal(existsSync(join(dir, 'source', file)), false);
  assert.ok(existsSync(join(fakeBin, r.body.trash, 'project', 'source', file)), 'in the Bin');
  assert.deepEqual(listed('gone'), []);
  assert.ok(!studioMod.listTakes().some((x) => x.id === 'final cut'));
  assert.match(readFileSync(join(dir, 'WORKLOG.md'), 'utf8'), /Deleted final cut \(from this video and from Recordings\)/);
  // Undo from the Bin brings it back into the video, and so into Recordings.
  const u = await trashCall('/api/trash/from-bin', { token: r.body.bin.undo });
  assert.equal(u.code, 200, JSON.stringify(u.body));
  assert.equal(listed('gone').length, 1);
});

test('a parked import deleted from Recordings goes to the Bin like a take', async () => {
  const dir = project('pdel');
  await upload(dir, 'aside.mp4');
  await mediaCall(dir, '/media-remove', { item: 'aside' });
  const r = await trashCall('/api/takes/delete', { take: 'aside' });
  assert.equal(r.code, 200, JSON.stringify(r.body));
  assert.ok(existsSync(join(fakeBin, r.body.trash, 'take', 'aside.mp4')));
  assert.ok(!studioMod.listTakes().some((x) => x.id === 'aside'));
});

test('both answers are refused while the video is busy; nothing moves', async () => {
  const dir = project('busy');
  const [file] = await upload(dir, 'wait.mp4');
  for (const action of ['/media-remove', '/media-delete']) {
    const r = await mediaCall(dir, action, { item: 'wait' }, { busy: 'Claude is working in this project: wait for it or stop it first.' });
    assert.equal(r.code, 409);
    assert.match(r.body.error, /Claude is working/);
  }
  assert.ok(existsSync(join(dir, 'source', file)));
  assert.ok(!existsSync(join(recordings, 'wait')));
  assert.equal(listed('busy').length, 1);
});

test('web: Recordings lists imports from /api/recordings with Imported, Open video and the two-answer Delete', () => {
  const src = (f) => readFileSync(new URL(`../${f}`, import.meta.url), 'utf8').replace(/\r\n/g, '\n');
  const app = src('web/app.js'), idx = src('server/index.mjs'), mjs = src('web/media.js');
  assert.match(idx, /p === '\/api\/recordings'/);
  assert.match(app, /renderRecordings\(main, await api\('\/api\/recordings'\)/);
  assert.match(app, /function importRow\(/);
  assert.match(app, /class="pill accent">Imported</);
  assert.match(app, /data-a="open"[^>]*>Open video</);
  assert.match(app, /actions\.deleteRecording\(\{ id: t\.item, name: t\.name/);
  assert.match(mjs, /Remove from “\$\{video\}”/);
  assert.match(mjs, /r\.parked \?/);
});
