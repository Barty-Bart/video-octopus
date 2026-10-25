// Delete recording's two answers and the computer's Bin (server/os-trash.mjs, media.mjs deleteRecording, trash.mjs):
// - Remove from this video keeps the take in Recordings (as before); Delete recording takes it out of this video and
//   Recordings too, and sends the whole trash entry to the Bin; with no Bin it stays in the studio's trash and Undo works.
// - Other videos that use the take are named and asked about first, and keep their own copies.
// - Refused while the take records or saves, and while the project is busy.
// - The Recordings page's Delete: asks when videos use the take, then goes to the Bin.
// - The Bin itself with fake commands (never the real Trash): Finder first, then /usr/bin/trash, then a rename into
//   <fake home>/.Trash; Windows' Recycle Bin script gets its path in an environment variable, only on a fixed drive.
// A throwaway studio, settings folder and home; synthetic bytes stand in for video.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync, rmSync, renameSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, basename } from 'node:path';

const tmp = mkdtempSync(join(tmpdir(), 'vo-bin-'));
const studio = join(tmp, 'studio');
const recordings = join(studio, 'recordings');
const projects = join(studio, 'projects');
const fakeBin = join(tmp, 'fake-bin');
process.env.STUDIO_LOCAL_DIR = join(tmp, 'local');
delete process.env.OCTOPUS_FAKE_BIN;
for (const d of [process.env.STUDIO_LOCAL_DIR, recordings, projects, fakeBin]) mkdirSync(d, { recursive: true });
writeFileSync(join(process.env.STUDIO_LOCAL_DIR, 'settings.json'), JSON.stringify({ studio }));

let media, trashMod, bin;
before(async () => {
  media = await import('../server/media.mjs');
  trashMod = await import('../server/trash.mjs');
  bin = await import('../server/os-trash.mjs');
});
after(() => { bin.setBinMover(null); rmSync(tmp, { recursive: true, force: true }); });

const readJ = (p) => JSON.parse(readFileSync(p, 'utf8'));
const writeJ = (p, v) => { mkdirSync(join(p, '..'), { recursive: true }); writeFileSync(p, JSON.stringify(v, null, 2)); };
const trash = () => join(studio, '.trash');
const trashEntries = () => (existsSync(trash()) ? readdirSync(trash()) : []);
const binItems = () => readdirSync(fakeBin);

// A fake Bin: the entry moves into fakeBin; the Undo token works as with Finder's answer.
const toBin = async (entry) => {
  const from = join(trash(), entry), to = join(fakeBin, entry);
  renameSync(from, to);
  return { where: 'the Trash', how: 'fake', putBack: true, undo: bin.rememberUndo({ path: to }, from) };
};

function take(stamp, extra = {}) {
  const dir = join(recordings, stamp);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${stamp}_webcam.mp4`), `recording ${stamp}`);
  writeJ(join(dir, 'take.json'), { recorder: 'browser', finished: Date.now(), files: [`${stamp}_webcam.mp4`], tracks: {}, ...extra });
  return dir;
}
function project(id, takes, active = takes.at(-1)) {
  const dir = join(projects, id);
  for (const d of ['source', 'work', 'renders']) mkdirSync(join(dir, d), { recursive: true });
  for (const t of takes) writeFileSync(join(dir, 'source', `${t}_webcam.mp4`), `copy of ${t}`);
  writeJ(join(dir, 'project.json'), { name: id.toUpperCase(), type: 'tutorial', takes, activeTake: active });
  return dir;
}
async function mediaCall(dir, action, payload) {
  let out = null;
  await media.mediaRoute({ method: 'POST' }, {}, { dir, action, send: (_r, code, body) => { out = { code, body }; }, body: async () => payload, emit: () => {}, busy: () => null, toBin });
  return out;
}
async function trashCall(path, payload, { toBin: tb = toBin } = {}) {
  let out = null;
  await trashMod.trashRoute({ method: 'POST' }, {}, new URL(`http://127.0.0.1${path}`), { send: (_r, code, body) => { out = { code, body }; }, body: async () => payload, toBin: tb });
  return out;
}

test('Remove from this video: the take stays in Recordings, as before', async () => {
  const A = '2026-10-24_08-00-00', B = '2026-10-24_08-10-00';
  take(A); take(B);
  const dir = project('keep', [A, B]);
  const r = await mediaCall(dir, '/media-remove', { item: B });
  assert.equal(r.code, 200, JSON.stringify(r.body));
  assert.ok(existsSync(join(recordings, B, `${B}_webcam.mp4`)), 'Recordings is not touched');
  assert.equal(r.body.recordings, false);
  assert.equal(readJ(join(dir, 'project.json')).activeTake, A);
  assert.equal(binItems().length, 0, 'nothing goes to the Bin');
});

test('Delete recording: out of this video and Recordings, the whole entry to the Bin; Undo brings everything back', async () => {
  const A = '2026-10-24_09-00-00', B = '2026-10-24_09-10-00';
  take(A); take(B);
  const dir = project('gone', [A, B]);
  const items = (await (async () => media.mediaItems(dir))()).items;
  assert.equal(items.find((x) => x.id === B).inRecordings, true, 'the Media list knows it is in Recordings');
  const r = await mediaCall(dir, '/media-delete', { item: B });
  assert.equal(r.code, 200, JSON.stringify(r.body));
  assert.equal(r.body.recordings, true);
  assert.equal(r.body.bin.where, 'the Trash');
  assert.equal(existsSync(join(recordings, B)), false, 'gone from Recordings');
  assert.equal(existsSync(join(dir, 'source', `${B}_webcam.mp4`)), false, 'gone from the video');
  assert.deepEqual(readJ(join(dir, 'project.json')).takes, [A]);
  assert.equal(readJ(join(dir, 'project.json')).activeTake, A);
  assert.ok(!trashEntries().includes(r.body.trash), 'not left in the studio’s trash');
  const inBin = join(fakeBin, r.body.trash);
  assert.equal(readFileSync(join(inBin, 'take', `${B}_webcam.mp4`), 'utf8'), `recording ${B}`, 'the recordings copy is in the Bin, not deleted');
  assert.equal(readFileSync(join(inBin, 'project', 'source', `${B}_webcam.mp4`), 'utf8'), `copy of ${B}`);
  assert.equal(readJ(join(inBin, 'manifest.json')).take, B);

  const u = await trashCall('/api/trash/from-bin', { token: r.body.bin.undo });
  assert.equal(u.code, 200, JSON.stringify(u.body));
  assert.ok(existsSync(join(recordings, B, `${B}_webcam.mp4`)), 'back in Recordings');
  assert.ok(existsSync(join(dir, 'source', `${B}_webcam.mp4`)), 'back in the video');
  assert.equal(readJ(join(dir, 'project.json')).activeTake, B, 'back on the canvas');
  assert.equal(existsSync(inBin), false);
  assert.equal((await trashCall('/api/trash/from-bin', { token: r.body.bin.undo })).code, 400, 'an Undo works once');
});

test('with no Bin it stays in the studio’s trash, says so (bin: null), and the usual Undo puts both copies back', async () => {
  const A = '2026-10-24_10-00-00', B = '2026-10-24_10-10-00';
  take(A); take(B);
  const dir = project('nobin', [A, B]);
  let out = null;
  await media.mediaRoute({ method: 'POST' }, {}, { dir, action: '/media-delete', send: (_r, code, body) => { out = { code, body }; }, body: async () => ({ item: B }), emit: () => {}, busy: () => null, toBin: async () => null });
  assert.equal(out.code, 200, JSON.stringify(out.body));
  assert.equal(out.body.bin, null);
  assert.ok(trashEntries().includes(out.body.trash));
  const view = trashMod.trashView().items.find((x) => x.trash === out.body.trash);
  assert.match(view.what, /Deleted recording, was in “NOBIN” and Recordings/);
  const u = await mediaCall(dir, '/media-restore', { trash: out.body.trash });
  assert.equal(u.code, 200, JSON.stringify(u.body));
  assert.ok(existsSync(join(recordings, B, `${B}_webcam.mp4`)));
  assert.ok(existsSync(join(dir, 'source', `${B}_webcam.mp4`)));
});

test('another video using the take is named and asked about first; it keeps its own copy', async () => {
  const A = '2026-10-24_11-00-00', B = '2026-10-24_11-10-00';
  take(A); take(B);
  const dir = project('mine', [A, B]);
  const other = project('theirs', [B]);
  const q = await mediaCall(dir, '/media-delete', { item: B });
  assert.equal(q.code, 409);
  assert.equal(q.body.ok, false);
  assert.match(q.body.confirm, /“THEIRS” also uses this take/);
  assert.deepEqual(q.body.others, ['THEIRS']);
  assert.ok(existsSync(join(recordings, B)), 'nothing moved before the answer');
  const r = await mediaCall(dir, '/media-delete', { item: B, confirm: true });
  assert.equal(r.code, 200, JSON.stringify(r.body));
  assert.ok(existsSync(join(other, 'source', `${B}_webcam.mp4`)), 'the other video keeps its copy');
  assert.equal(readJ(join(other, 'project.json')).activeTake, B, 'and its canvas take');
  assert.equal(existsSync(join(recordings, B)), false);
});

test('refused while the take records or saves, and while Claude or an export is working', async () => {
  const A = '2026-10-24_12-00-00', B = '2026-10-24_12-10-00';
  take(A); take(B, { finished: null, project: 'live' });
  const dir = project('live', [A, B]);
  const r = await mediaCall(dir, '/media-delete', { item: B });
  assert.equal(r.code, 409);
  assert.match(r.body.error, /still recording or saving/);
  let out = null;
  await media.mediaRoute({ method: 'POST' }, {}, { dir, action: '/media-delete', send: (_r, code, body) => { out = { code, body }; }, body: async () => ({ item: A }), emit: () => {}, busy: () => 'Claude is working in this project: wait for it or stop it first.', toBin });
  assert.equal(out.code, 409);
  assert.match(out.body.error, /Claude is working/);
  assert.ok(existsSync(join(recordings, B)) && existsSync(join(dir, 'source', `${A}_webcam.mp4`)), 'nothing moved');
});

test('an imported file (listed in Recordings where it is, A17) goes to the Bin, out of the video and Recordings', async () => {
  const A = '2026-10-24_13-00-00';
  take(A);
  const dir = project('imp', [A]);
  writeFileSync(join(dir, 'source', 'clip.mp4'), 'imported');
  assert.equal(media.mediaItems(dir).items.find((x) => x.id === 'clip').inRecordings, true);
  const r = await mediaCall(dir, '/media-delete', { item: 'clip' });
  assert.equal(r.code, 200, JSON.stringify(r.body));
  assert.equal(r.body.recordings, true);
  assert.ok(!media.importedRecordings().some((x) => x.project === 'imp'), 'gone from Recordings');
  assert.ok(existsSync(join(fakeBin, r.body.trash, 'project', 'source', 'clip.mp4')));
});

test('Recordings’ Delete asks when videos use the take, then sends it to the Bin', async () => {
  const S = '2026-10-24_14-00-00';
  take(S);
  const v = project('user', [S]);
  const q = await trashCall('/api/takes/delete', { take: S });
  assert.equal(q.code, 409);
  assert.match(q.body.confirm, /“USER” uses this take\. That video keeps its own copy/);
  const r = await trashCall('/api/takes/delete', { take: S, confirm: true });
  assert.equal(r.code, 200, JSON.stringify(r.body));
  assert.equal(r.body.bin.where, 'the Trash');
  assert.equal(existsSync(join(recordings, S)), false);
  assert.ok(existsSync(join(fakeBin, r.body.trash, 'take', `${S}_webcam.mp4`)));
  assert.ok(existsSync(join(v, 'source', `${S}_webcam.mp4`)), 'the video keeps its copy');
  const u = await trashCall('/api/trash/from-bin', { token: r.body.bin.undo });
  assert.equal(u.code, 200, JSON.stringify(u.body));
  assert.ok(existsSync(join(recordings, S, `${S}_webcam.mp4`)), 'Undo: back in Recordings');
});

test('binEntry: no Bin → null and the entry stays; an odd name is refused', async () => {
  bin.setBinMover(async () => null);
  mkdirSync(join(trash(), '2026-10-24_15-00-00-x'), { recursive: true });
  assert.equal(await trashMod.binEntry('2026-10-24_15-00-00-x'), null);
  assert.ok(existsSync(join(trash(), '2026-10-24_15-00-00-x')));
  assert.equal(await trashMod.binEntry('../../etc'), null);
  bin.setBinMover(null);
});

// ---- the Bin itself, with fake commands and a fake home: never the real Trash ----
// The quote-laden folder name is not a valid Windows file name; the macOS path is what this test checks.
test('macOS: Finder first (Put Back works), the path as one argument, never in the script', { skip: process.platform === 'win32' && 'macOS file names' }, async () => {
  const home = join(tmp, 'home-a'); mkdirSync(join(home, '.Trash'), { recursive: true });
  const item = join(tmp, 'entry "a"; do shell script'); mkdirSync(item);
  const calls = [];
  const run = async (cmd, args) => {
    calls.push([cmd, args]);
    const to = join(home, '.Trash', basename(args.at(-1)));
    renameSync(args.at(-1), to);
    return { err: null, out: `${to}\n`, errOut: '' };
  };
  const r = await bin.sendToBin(item, { platform: 'darwin', home, run });
  assert.equal(r.how, 'finder');
  assert.equal(r.putBack, true);
  assert.equal(r.where, 'the Trash');
  assert.equal(calls[0][0], '/usr/bin/osascript');
  assert.equal(calls[0][1].at(-1), item, 'the path is the last argument');
  assert.ok(!calls[0][1].slice(0, -1).some((a) => a.includes(item)), 'and nowhere in the script');
  assert.ok(calls[0][1].includes('tell application "Finder" to set r to delete f'));
  assert.ok(existsSync(r.path));
});

test('macOS: Finder refused → /usr/bin/trash; that failing too → a rename into ~/.Trash with a free name', async () => {
  const home = join(tmp, 'home-b'); mkdirSync(join(home, '.Trash', 'entry'), { recursive: true });
  const item = join(tmp, 'b', 'entry'); mkdirSync(item, { recursive: true });
  const calls = [];
  const run = async (cmd) => { calls.push(cmd); return { err: new Error('failed'), out: '', errOut: cmd.includes('osascript') ? 'Not authorized to send Apple events to Finder. (-1743)' : 'no' }; };
  const r = await bin.sendToBin(item, { platform: 'darwin', home, run });
  assert.equal(r.how, 'rename');
  assert.equal(r.path, join(home, '.Trash', 'entry 2'), 'never over an item already in the Trash');
  assert.ok(existsSync(join(r.path)));
  if (existsSync('/usr/bin/trash')) assert.deepEqual(calls, ['/usr/bin/osascript', '/usr/bin/trash']);
  // Refused once: Finder isn't asked again.
  const item2 = join(tmp, 'b', 'entry-two'); mkdirSync(item2);
  calls.length = 0;
  await bin.sendToBin(item2, { platform: 'darwin', home, run });
  assert.ok(!calls.includes('/usr/bin/osascript'));
});

test('macOS: no ~/.Trash and nothing else worked → null: it stays where it was', async () => {
  const home = join(tmp, 'home-c'); mkdirSync(home);
  const item = join(tmp, 'c-entry'); mkdirSync(item);
  const r = await bin.sendToBin(item, { platform: 'darwin', home, run: async () => ({ err: new Error('no'), out: '', errOut: '' }) });
  assert.equal(r, null);
  assert.ok(existsSync(item));
});

test('Windows: the Recycle Bin script, with the path in VO_BIN_PATH and a fixed-drive check; exit 3 → null', async () => {
  const item = join(tmp, 'w-entry'); mkdirSync(item);
  let seen = null;
  const r = await bin.sendToBin(item, { platform: 'win32', run: async (cmd, args, opts) => { seen = { cmd, args, opts }; return { err: Object.assign(new Error('exit 3'), { code: 3 }), out: '', errOut: '' }; } });
  assert.equal(r, null);
  assert.equal(seen.cmd, 'powershell.exe');
  assert.equal(seen.opts.env.VO_BIN_PATH, item);
  const script = seen.args.at(-1);
  assert.match(script, /SendToRecycleBin/);
  assert.match(script, /DriveType -ne 'Fixed'/);
  assert.ok(!script.includes(item), 'the path is never in the script');
  const ok = await bin.sendToBin(item, { platform: 'win32', run: async (_c, _a, opts) => { rmSync(opts.env.VO_BIN_PATH, { recursive: true }); return { err: null, out: '', errOut: '' }; } });
  assert.equal(ok.where, 'the Recycle Bin');
});

test('Linux and others: no Bin (the studio’s trash keeps it)', async () => {
  const item = join(tmp, 'l-entry'); mkdirSync(item);
  assert.equal(await bin.sendToBin(item, { platform: 'linux', run: async () => { throw new Error('never run'); } }), null);
  assert.equal(bin.binName('linux'), null);
  assert.equal(bin.binName('darwin'), 'the Trash');
});

test('the web side: one question, two answers, Don’t ask again, and a Settings row to change it', () => {
  const js = readFileSync(new URL('../web/media.js', import.meta.url), 'utf8');
  assert.match(js, /export function deleteChoice/);
  assert.match(js, /Remove from this video/);
  assert.match(js, /data-c="bin"><b>Delete recording/);
  assert.match(js, /Don’t ask again/);
  assert.match(js, /\/media-delete/);
  const set = readFileSync(new URL('../web/settings.js', import.meta.url), 'utf8');
  assert.match(set, /deleteRecording/);
  const app = readFileSync(new URL('../web/app.js', import.meta.url), 'utf8');
  assert.match(app, /\/api\/trash\/from-bin/);
});
