// The studio's trash on the server side (server/trash.mjs): the list Settings › Storage › Trash shows (size, count,
// what each item was, whether it can go back), Put back for a deleted take and for media removed from a video (refused
// when the target exists again, its video is gone, or the video is busy), Empty trash (only with confirmation, all of
// it or the items older than N days, never anything outside the trash), and the Recordings page's Delete with its Undo
// (refused while the take is recording, and when any video uses it, naming them). Plus static checks of the web side.
// A throwaway studio and settings folder; synthetic bytes stand in for video.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync, rmSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const tmp = mkdtempSync(join(tmpdir(), 'vo-trash-'));
const studio = join(tmp, 'studio');
const recordings = join(studio, 'recordings');
const projects = join(studio, 'projects');
process.env.STUDIO_LOCAL_DIR = join(tmp, 'local');
mkdirSync(process.env.STUDIO_LOCAL_DIR, { recursive: true });
writeFileSync(join(process.env.STUDIO_LOCAL_DIR, 'settings.json'), JSON.stringify({ studio }));
mkdirSync(recordings, { recursive: true });

let trashMod, media;
before(async () => {
  trashMod = await import('../server/trash.mjs');
  media = await import('../server/media.mjs');
  // The Recordings page's Delete sends its entry on to the computer's Bin: here no Bin takes it (never the real Trash),
  // so it stays in the studio's trash as before (test/delete-to-bin.test.mjs covers the Bin).
  (await import('../server/os-trash.mjs')).setBinMover(async () => null);
});
after(() => rmSync(tmp, { recursive: true, force: true }));

const readJ = (p) => JSON.parse(readFileSync(p, 'utf8'));
const writeJ = (p, v) => { mkdirSync(join(p, '..'), { recursive: true }); writeFileSync(p, JSON.stringify(v, null, 2)); };
const trash = () => join(studio, '.trash');
const trashEntries = () => (existsSync(trash()) ? readdirSync(trash()).sort() : []);
const HOUR_AGO = (Date.now() - 3600e3) / 1000;

function project(id, meta = {}) {
  const dir = join(projects, id);
  for (const d of ['source', 'work', 'renders']) mkdirSync(join(dir, d), { recursive: true });
  writeJ(join(dir, 'project.json'), { name: id.toUpperCase(), ...meta });
  return dir;
}
// A finished take in the recordings folder (not in any project).
function recording(stamp, { files = [`${stamp}_webcam.mp4`], take = { recorder: 'browser', finished: Date.now() } } = {}) {
  const dir = join(recordings, stamp);
  mkdirSync(dir, { recursive: true });
  for (const f of files) writeFileSync(join(dir, f), `media ${f}`);
  if (take) writeJ(join(dir, 'take.json'), { ...take, files, tracks: {} });
  return dir;
}

// One route call, the way server/index.mjs makes it.
async function call(path, payload = {}, { method = 'POST', busy = () => null } = {}) {
  let out = null;
  const events = [];
  const answered = await trashMod.trashRoute({ method }, {}, new URL(`http://127.0.0.1${path}`), {
    send: (_res, code, body) => { out = { code, body }; },
    body: async () => payload,
    busy,
    emit: (id, ev) => events.push([id, ev]),
  });
  assert.equal(answered, true);
  return { ...out, events };
}
const list = async () => (await call('/api/trash', null, { method: 'GET' })).body;
const clear = () => rmSync(trash(), { recursive: true, force: true });

test('other paths are not the trash route’s', async () => {
  const answered = await trashMod.trashRoute({ method: 'GET' }, {}, new URL('http://127.0.0.1/api/takes'), { send: () => {}, body: async () => ({}) });
  assert.equal(answered, false);
});

test('Recordings Delete moves an unused take to the trash; the list shows it; Undo puts it back', async () => {
  clear();
  const stamp = '2026-10-24_09-00-00';
  recording(stamp);
  const d = await call('/api/takes/delete', { take: stamp });
  assert.equal(d.code, 200, JSON.stringify(d.body));
  assert.equal(existsSync(join(recordings, stamp)), false);
  const entry = join(trash(), d.body.trash);
  assert.equal(readFileSync(join(entry, 'take', `${stamp}_webcam.mp4`), 'utf8'), `media ${stamp}_webcam.mp4`, 'nothing is deleted');
  const m = readJ(join(entry, 'manifest.json'));
  assert.equal(m.kind, 'deleted');
  assert.equal(m.project, null, 'from Recordings, no project');

  const v = await list();
  assert.equal(v.count, 1);
  assert.ok(v.bytes > 0, 'the size counts the files');
  assert.equal(v.items[0].trash, d.body.trash);
  assert.equal(v.items[0].restorable, true);
  assert.match(v.items[0].what, /Deleted take, from Recordings/);
  assert.equal(v.where, trash());

  const u = await call('/api/takes/restore', { trash: d.body.trash });
  assert.equal(u.code, 200, JSON.stringify(u.body));
  assert.ok(existsSync(join(recordings, stamp, `${stamp}_webcam.mp4`)));
  assert.deepEqual(trashEntries(), [], 'the emptied entry goes');
  assert.equal((await call('/api/takes/restore', { trash: d.body.trash })).code, 400, 'an Undo only works once');
});

test('Recordings Delete asks first while any video uses the take, naming every one, and is refused while it records', async () => {
  clear();
  const stamp = '2026-10-24_09-30-00';
  recording(stamp);
  project('alpha', { takes: [stamp], activeTake: stamp });
  const beta = project('beta');
  writeFileSync(join(beta, 'source', `${stamp}_webcam.mp4`), 'copy');
  const d = await call('/api/takes/delete', { take: stamp });
  assert.equal(d.code, 409);
  assert.equal(d.body.ok, false);
  assert.match(d.body.confirm, /“ALPHA”, “BETA” use this take/);
  assert.match(d.body.confirm, /Those videos keep their own copies/);
  assert.ok(existsSync(join(recordings, stamp)), 'nothing moved');
  assert.deepEqual(trashEntries(), []);

  const live = '2026-10-24_09-45-00';
  recording(live, { take: { recorder: 'browser', project: 'alpha' } });
  const r = await call('/api/takes/delete', { take: live });
  assert.equal(r.code, 409);
  assert.match(r.body.error, /still recording or saving/);

  assert.equal((await call('/api/takes/delete', { take: '../projects' })).code, 400, 'not a take name');
  assert.equal((await call('/api/takes/delete', { take: 'missing' })).code, 400);
});

test('the record panel’s Delete take still works for its own project (id unchanged)', async () => {
  clear();
  const rec = await import('../server/browser-recorder.mjs');
  const stamp = '2026-10-24_09-50-00';
  recording(stamp, { take: { recorder: 'browser', project: 'gamma', finished: Date.now() } });
  const dir = project('gamma', { takes: [stamp], activeTake: stamp });
  writeFileSync(join(dir, 'source', `${stamp}_webcam.mp4`), 'copy');
  const r = rec.deleteTake('gamma', stamp);
  assert.equal(r.project, 'gamma');
  assert.throws(() => rec.deleteTake('other', '2026-01-01_00-00-00'), /recordings folder/);
});

test('Put back: a deleted take goes back to its video; refused when it is there again or the video is busy', async () => {
  clear();
  const rec = await import('../server/browser-recorder.mjs');
  const stamp = '2026-10-24_10-00-00';
  recording(stamp, { take: { recorder: 'browser', project: 'delta', finished: Date.now() } });
  const dir = project('delta', { takes: [stamp], activeTake: stamp });
  writeFileSync(join(dir, 'source', `${stamp}_webcam.mp4`), 'copy');
  const d = rec.deleteTake('delta', stamp);
  const v = await list();
  assert.match(v.items[0].what, /Deleted take, was in “DELTA”/);

  const busy = await call('/api/trash/restore', { trash: d.trash }, { busy: (id) => (id === 'delta' ? 'Claude is working in this project.' : null) });
  assert.equal(busy.code, 409);
  assert.match(busy.body.error, /Claude is working/);

  // A take with that name is back in the recordings folder: refused, nothing moves.
  recording(stamp);
  const again = await call('/api/trash/restore', { trash: d.trash });
  assert.equal(again.code, 409);
  assert.match(again.body.error, /already/);
  assert.ok(existsSync(join(trash(), d.trash, 'take')));
  rmSync(join(recordings, stamp), { recursive: true });

  const ok = await call('/api/trash/restore', { trash: d.trash });
  assert.equal(ok.code, 200, JSON.stringify(ok.body));
  assert.deepEqual(ok.events, [['delta', { t: 'files' }]], 'the video refreshes');
  assert.equal(readJ(join(dir, 'project.json')).activeTake, stamp);
  assert.ok(existsSync(join(dir, 'source', `${stamp}_webcam.mp4`)));
  assert.deepEqual(trashEntries(), []);
});

test('Put back: media removed from a video comes back; refused when the file is there again or the video is gone', async () => {
  clear();
  const dir = project('eps', { takes: [], layout: { preset: 'full' } });
  writeFileSync(join(dir, 'source', 'clip.mp4'), 'clip');
  utimesSync(join(dir, 'source', 'clip.mp4'), HOUR_AGO, HOUR_AGO);
  const r = media.removeMedia(dir, 'clip');
  assert.equal(r.ok, true);
  const v = await list();
  assert.match(v.items[0].what, /Removed from “EPS”/);
  assert.equal(v.items[0].restorable, true);

  writeFileSync(join(dir, 'source', 'clip.mp4'), 'a new clip');
  const again = await call('/api/trash/restore', { trash: r.trash });
  assert.equal(again.code, 409);
  assert.match(again.body.error, /in the project again already/);
  assert.equal(readFileSync(join(dir, 'source', 'clip.mp4'), 'utf8'), 'a new clip', 'the new file is untouched');
  rmSync(join(dir, 'source', 'clip.mp4'));

  const ok = await call('/api/trash/restore', { trash: r.trash });
  assert.equal(ok.code, 200, JSON.stringify(ok.body));
  assert.equal(readFileSync(join(dir, 'source', 'clip.mp4'), 'utf8'), 'clip');

  // Its video archived (moved out of projects/): listed, but Put back says why not.
  const r2 = media.removeMedia(dir, 'clip');
  mkdirSync(join(projects, '_archive'), { recursive: true });
  rmSync(join(projects, '_archive', 'eps'), { recursive: true, force: true });
  (await import('node:fs')).renameSync(dir, join(projects, '_archive', 'eps'));
  const item = (await list()).items.find((x) => x.trash === r2.trash);
  assert.equal(item.restorable, false);
  assert.match(item.why, /gone or archived/);
  assert.equal((await call('/api/trash/restore', { trash: r2.trash })).code, 409);
});

test('a take dropped by Restart is listed but cannot be put back; unknown names are refused', async () => {
  clear();
  const n = '2026-10-24_11-00-00-2026-10-24_10-59-00';
  mkdirSync(join(trash(), n, 'take'), { recursive: true });
  writeFileSync(join(trash(), n, 'take', 'x.webm.part'), 'parts');
  writeJ(join(trash(), n, 'manifest.json'), { v: 1, kind: 'discarded', take: '2026-10-24_10-59-00', at: Date.now(), project: 'x' });
  const v = await list();
  assert.equal(v.items[0].restorable, false);
  assert.match(v.items[0].what, /Dropped by Restart/);
  assert.equal((await call('/api/trash/restore', { trash: n })).code, 409);
  assert.equal((await call('/api/trash/restore', { trash: '../projects' })).code, 400);
});

test('Empty trash needs confirmation, deletes every item for good and nothing outside the trash', async () => {
  clear();
  for (const s of ['2026-10-24_12-00-00', '2026-10-24_12-01-00']) { recording(s); await call('/api/takes/delete', { take: s }); }
  // Not trash entries: a stray file and a folder with another name stay.
  writeFileSync(join(trash(), 'README.txt'), 'keep');
  mkdirSync(join(trash(), 'not-an-entry'));
  const before = await list();
  assert.equal(before.count, 2);

  const no = await call('/api/trash/empty', {});
  assert.equal(no.code, 400);
  assert.match(no.body.error, /confirmation/);
  assert.equal((await call('/api/trash/empty', { confirm: 'yes' })).code, 400, 'only confirm: true');
  assert.equal((await list()).count, 2, 'nothing went');

  const ok = await call('/api/trash/empty', { confirm: true });
  assert.equal(ok.code, 200, JSON.stringify(ok.body));
  assert.equal(ok.body.removed, 2);
  assert.equal(ok.body.bytes, before.bytes);
  assert.deepEqual(trashEntries(), ['README.txt', 'not-an-entry']);
  assert.equal((await list()).count, 0);
  assert.ok(existsSync(recordings), 'the recordings folder is untouched');
});

test('Delete items older than 30 days keeps the newer ones', async () => {
  clear();
  const old = '2026-09-01_08-00-00-2026-09-01_07-00-00', fresh = '2026-10-24_13-00-00-2026-10-24_12-59-00';
  for (const [n, at] of [[old, Date.now() - 40 * 86400000], [fresh, Date.now() - 2 * 86400000]]) {
    mkdirSync(join(trash(), n, 'take'), { recursive: true });
    writeFileSync(join(trash(), n, 'take', 'a.mp4'), 'bytes');
    writeJ(join(trash(), n, 'manifest.json'), { v: 1, kind: 'deleted', take: n.slice(-19), at, project: null });
  }
  assert.equal((await call('/api/trash/empty', { confirm: true, olderThanDays: 0 })).code, 400);
  const r = await call('/api/trash/empty', { confirm: true, olderThanDays: 30 });
  assert.equal(r.code, 200, JSON.stringify(r.body));
  assert.equal(r.body.removed, 1);
  assert.deepEqual(trashEntries(), [fresh]);
});

test('web: Settings › Storage has Trash; Recordings rows have Delete with Undo', () => {
  const settings = readFileSync(new URL('../web/settings.js', import.meta.url), 'utf8');
  assert.match(settings, /\['folders', 'storage', 'trash', 'usage'\]/);
  assert.match(settings, /DRAW\.trash = \(V, save\) => trashSection/);
  const trash = readFileSync(new URL('../web/trash.js', import.meta.url), 'utf8');
  assert.match(trash, /\/api\/trash\/empty', \{ confirm: true/);
  assert.match(trash, /\/api\/trash\/restore/);
  assert.match(trash, /can’t be undone/);
  assert.match(trash, /\$\('\[data-a=no\]', m\)\.focus\(\)/, 'the safe answer has the focus');
  const app = readFileSync(new URL('../web/app.js', import.meta.url), 'utf8');
  assert.match(app, /\/api\/takes\/delete/);
  assert.match(app, /\/api\/takes\/restore/);
  const index = readFileSync(new URL('../server/index.mjs', import.meta.url), 'utf8');
  assert.match(index, /trashRoute\(req, res, url, \{ send, body, busy: mediaBusy, emit: broadcast \}\)/);
});
