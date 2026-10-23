// Packaging Phase 0 + 1 (handoff packaging-2026-10-23): the shared scope ladder, resources and their channel isolation,
// the move of brand-asset blobs into the file store, the Codex image item mapping, cutting a contact sheet and the
// board's rules. Synthetic studios and images only; no agent, model or network.
//   node --test test/packaging.test.mjs
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { syncSkills } from '../server/managed-skills.mjs';
import { ProfileStore } from '../server/profile-store.mjs';
import { PackagingStore, MAX_WINNERS } from '../server/packaging-store.mjs';
import { scopeChain, parseScope, visibleAt, LEVELS, RESOURCE_LEVELS } from '../server/scope-chain.mjs';
import { addResource, updateResource, archiveResource, listResources, canAttach, migrateProfileAssets } from '../server/resource-store.mjs';
import { png, sheetPng, SHEET_COLOURS } from './png-fixture.mjs';

// images.mjs and packaging.mjs load the app's settings module, which keeps a local folder: a disposable one here.
const LOCAL = realpathSync(mkdtempSync(join(tmpdir(), 'octopus-packaging-local-')));
process.env.STUDIO_LOCAL_DIR ||= LOCAL;
process.on('exit', () => rmSync(LOCAL, { recursive: true, force: true }));
const { codexImage, imageSize, sheetBoxes, cutBoxes, fitThumbnail, usageLimitText, SHEET_GRID } = await import('../server/images.mjs');

const sha = (b) => createHash('sha256').update(b).digest('hex');
// Temporary studios are removed once every test has finished: a test's own after-hooks close its stores, and
// Windows can't delete a folder while its SQLite file is still open (hooks run in the order they were added).
const roots = [];
after(() => { for (const root of roots) rmSync(root, { recursive: true, force: true }); });
function studio(t) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'octopus-packaging-')));
  writeFileSync(join(root, 'CLAUDE.md'), 'Synthetic studio.');
  syncSkills({ studio: root, fresh: true });
  roots.push(root);
  return root;
}
const open = (t, root) => { const s = new PackagingStore(root); t.after(() => { try { s.close(); } catch {} }); return s; };
// A project of a channel, pinned the way New video pins it.
function project(s, root, id, profileId) {
  const dir = join(root, 'projects', id);
  mkdirSync(dir, { recursive: true });
  s.pinContext(id, { ...s.bundle({ profileId, type: 'short' }) });
  return dir;
}

test('scopeChain: one ladder, levels as data, hidden levels show under the nearest parent', () => {
  const ids = { profileId: 'A', formatId: 'F', project: 'p1' };
  assert.deepEqual(scopeChain(ids), ['global', 'profile:A', 'format:F', 'project:p1']);
  assert.deepEqual(scopeChain(ids, { levels: RESOURCE_LEVELS }), ['global', 'profile:A', 'project:p1']);
  assert.deepEqual(scopeChain({ project: 'p2' }), ['global', 'project:p2']);
  assert.deepEqual(scopeChain({}), ['global']);
  assert.deepEqual(parseScope('profile:A'), { level: 'profile', id: 'A' });
  assert.deepEqual(parseScope('global'), { level: 'global', id: null });
  for (const bad of ['', 'profile:', 'team:x', 'profile:a:b', null]) assert.equal(parseScope(bad), null);
  // Format switched off: a format record shows at the channel, tagged with where it came from.
  assert.deepEqual(visibleAt('format:F', ids, { levels: RESOURCE_LEVELS }), { shownAt: 'profile:A', from: 'format:F' });
  assert.deepEqual(visibleAt('format:F', ids, { levels: LEVELS }), { shownAt: 'format:F', from: null });
  // Another channel's or video's record is never visible.
  assert.equal(visibleAt('profile:B', ids), null);
  assert.equal(visibleAt('project:p2', ids), null);
});

test('memory chats and the project rebind share the ladder; the Packaging chat gets the project chat’s memories', (t) => {
  const root = studio(t), s = open(t, root);
  const a = s.profile('Alpha'), dir = project(s, root, 'vid', a.id);
  s.close();
  return import('../server/memory-store.mjs').then(({ MemoryStore }) => {
    const m = new MemoryStore(root);
    t.after(() => m.close());
    const main = m.register('vid', { project: 'vid' });
    const pack = m.register('vid.packaging', { project: 'vid' });
    assert.deepEqual(main.scopes, ['global', `profile:${a.id}`, 'project:vid']);
    assert.deepEqual(pack.scopes, main.scopes);
    assert.equal(m.register('other.packaging', { project: 'vid' }), null, 'only the project’s own packaging chat');
    assert.ok(existsSync(dir));
  });
});

test('resources: add, update, move (logged), archive; a photo must say who is in it; what may be attached', (t) => {
  const root = studio(t), s = open(t, root);
  const a = s.profile('Alpha');
  const logo = addResource(s, { scope: `profile:${a.id}`, name: 'logo.png', kind: 'logo', bytes: png(8, 8, () => [255, 0, 0]), use: 'always' });
  assert.equal(logo.likeness, 'nobody');
  assert.ok(s.files.has(logo.hash), 'bytes are in the file store');
  assert.equal(s.db.prepare("SELECT count(*) n FROM resources WHERE scope=?").get(`profile:${a.id}`).n, 1);
  assert.throws(() => addResource(s, { scope: 'global', name: 'me.jpg', kind: 'photo', bytes: png(4, 4, () => [1, 2, 3]) }), /who is in this photo/);
  assert.throws(() => addResource(s, { scope: 'format:x', name: 'a.png', bytes: png(4, 4, () => [0, 0, 0]) }), /All channels, a channel or a video/);
  assert.throws(() => addResource(s, { scope: 'global', name: 'a.exe', bytes: Buffer.from('x') }), /Choose an image/);
  const me = addResource(s, { scope: 'global', name: 'me.png', kind: 'photo', likeness: 'self', use: 'always', bytes: png(4, 4, () => [9, 9, 9]) });
  const friend = addResource(s, { scope: 'global', name: 'friend.png', kind: 'photo', likeness: 'other', bytes: png(4, 4, () => [8, 8, 8]) });
  const note = addResource(s, { scope: 'global', name: 'Style', kind: 'note', text: 'Bold yellow text, no gradients.' });
  assert.equal(canAttach(me), true);
  assert.equal(canAttach(friend), false, 'someone else is never sent');
  assert.equal(canAttach(note), false);
  assert.equal(canAttach({ ...logo, use: 'never' }), false);
  const renamed = updateResource(s, logo.id, { expected: 1, note: 'Top right corner' });
  assert.equal(renamed.revision, 2);
  assert.throws(() => updateResource(s, logo.id, { expected: 1, note: 'stale' }), /changed/);
  const moved = updateResource(s, logo.id, { expected: 2, scope: 'global' });
  assert.equal(moved.scope, 'global');
  assert.deepEqual(moved.moves.map((x) => [x.from, x.to]), [[`profile:${a.id}`, 'global']]);
  assert.equal(listResources(s, ['global']).length, 4);
  archiveResource(s, friend.id, { expected: 1 });
  assert.equal(listResources(s, ['global']).length, 3);
  assert.equal(listResources(s, ['global'], { archived: true }).length, 4);
  // The Storage page never lists a resource's file as unused.
  assert.ok(!s.fileReport().unused.some((x) => x.sha256 === me.hash));
  assert.throws(() => s.deleteUnusedFiles([me.hash]), /still used/);
});

test('resources: a video sees All channels, its own channel and itself — never another channel or video', (t) => {
  const root = studio(t), s = open(t, root);
  const A = s.profile('Alpha'), B = s.profile('Beta');
  const dirA = project(s, root, 'alpha-video', A.id);
  project(s, root, 'beta-video', B.id);
  project(s, root, 'alpha-other', A.id);
  const put = (scope, name) => addResource(s, { scope, name: `${name}.png`, bytes: png(4, 4, () => [name.length * 20, 0, 0]) });
  put('global', 'everyone');
  put(`profile:${A.id}`, 'alpha-logo');
  put(`profile:${B.id}`, 'beta-logo');
  put('project:alpha-video', 'alpha-shot');
  put('project:beta-video', 'beta-shot');
  put('project:alpha-other', 'sibling-shot');
  const names = (project) => s.chainResources(project).map((r) => r.name).sort();
  assert.deepEqual(names('alpha-video'), ['alpha-logo.png', 'alpha-shot.png', 'everyone.png']);
  assert.deepEqual(names('beta-video'), ['beta-logo.png', 'beta-shot.png', 'everyone.png']);
  // The projection: RESOURCES.md and copies, by level, with nothing from Beta.
  s.writeResources('alpha-video', dirA);
  const md = readFileSync(join(dirA, 'packaging/RESOURCES.md'), 'utf8');
  assert.match(md, /## All channels[\s\S]*everyone\.png[\s\S]*## Channel: Alpha[\s\S]*alpha-logo\.png[\s\S]*## This video[\s\S]*alpha-shot\.png/);
  assert.doesNotMatch(md, /beta|sibling/i);
  const copies = ['all-channels', 'channel', 'this-video'].flatMap((d) => readdirSync(join(dirA, 'packaging/resources', d)));
  assert.equal(copies.length, 3);
  // Live: archiving the channel logo takes it out of the projection at the next write.
  const logo = s.chainResources('alpha-video').find((r) => r.name === 'alpha-logo.png');
  archiveResource(s, logo.id, {});
  s.writeResources('alpha-video', dirA);
  assert.equal(readdirSync(join(dirA, 'packaging/resources/channel')).length, 0);
  assert.doesNotMatch(readFileSync(join(dirA, 'packaging/RESOURCES.md'), 'utf8'), /alpha-logo/);
  // A record at a level that is switched off (Format) shows under the channel, tagged.
  s.db.prepare('INSERT INTO resources VALUES(?,?,?)').run('fmt-1', 'format:none', JSON.stringify({ id: 'fmt-1', scope: 'format:none', name: 'x.png', kind: 'image' }));
  assert.ok(!s.chainResources('alpha-video').some((r) => r.id === 'fmt-1'), 'a format not in this video’s chain stays out');
});

test('profile_assets migration: backed up once, verified, idempotent, keeps ids and brand projections', async (t) => {
  const root = studio(t);
  let s = new ProfileStore(root);
  const p = s.profile('Alpha');
  // Legacy rows exactly as beta.12 wrote them (bytes in SQLite).
  const logo = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'), font = Buffer.from('fake font bytes');
  const ids = ['11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222'];
  s.db.prepare('INSERT INTO profile_assets VALUES(?,?,?,?,?)').run(ids[0], p.id, 'logo.svg', sha(logo), logo);
  s.db.prepare('INSERT INTO profile_assets VALUES(?,?,?,?,?)').run(ids[1], p.id, 'Brand Font.woff2', sha(font), font);
  s.db.prepare("DELETE FROM file_store_meta WHERE key LIKE 'profile-assets-migration%'").run();
  s.saveBrand(p.id, { identity: 'Alpha', assets: ids }, null);
  s.close();
  // First open migrates.
  s = new ProfileStore(root);
  t.after(() => { try { s.close(); } catch {} });
  assert.equal(s.db.prepare('SELECT count(*) n FROM profile_assets').get().n, 0);
  assert.equal(s.meta('profile-assets-migration'), 'done');
  const backups = readdirSync(join(root, '.studio/profile-assets-migration-backups'));
  assert.equal(backups.length, 1);
  const backup = new DatabaseSync(join(root, '.studio/profile-assets-migration-backups', backups[0], 'studio.sqlite'), { readOnly: true });
  assert.equal(backup.prepare('SELECT count(*) n FROM profile_assets').get().n, 2, 'the backup holds the blobs');
  backup.close();
  assert.deepEqual(s.assets(p.id).map((a) => a.id).sort(), ids);
  assert.deepEqual(s.asset(p.id, ids[0]).bytes, logo);
  assert.equal(listResources(s, [`profile:${p.id}`]).find((r) => r.id === ids[1]).kind, 'font');
  // The pinned project's context still gets the asset bytes, under the same file names.
  s.pinContext('vid', s.bundle({ profileId: p.id, type: 'short' }));
  const dir = join(root, 'projects', 'vid');
  mkdirSync(dir, { recursive: true });
  const x = s.materialize('vid', dir);
  assert.deepEqual(readFileSync(join(x.path, 'assets', `${ids[1]}-Brand Font.woff2`)), font);
  // Running again is a no-op (no second backup).
  assert.deepEqual(migrateProfileAssets(s), { moved: 0, done: true });
  s.close();
  s = new ProfileStore(root);
  assert.equal(readdirSync(join(root, '.studio/profile-assets-migration-backups')).length, 1);
  // New uploads go straight to the file store.
  const up = s.uploadAsset(p.id, 'new.png', png(2, 2, () => [0, 0, 0]));
  assert.equal(s.db.prepare('SELECT count(*) n FROM profile_assets').get().n, 0);
  assert.equal(s.assets(p.id).length, 3);
  assert.ok(s.asset(p.id, up.id).bytes.length > 0);
});

test('profile_assets migration resumes after an interruption without a second backup', async (t) => {
  const root = studio(t);
  const s = new ProfileStore(root);
  t.after(() => { try { s.close(); } catch {} });
  const p = s.profile('Alpha');
  const files = [Buffer.from('one'), Buffer.from('two'), Buffer.from('three')].map((b, i) => ({ id: `3333333${i}-3333-4333-8333-333333333333`, bytes: b, name: `f${i}.png` }));
  for (const f of files) s.db.prepare('INSERT INTO profile_assets VALUES(?,?,?,?,?)').run(f.id, p.id, f.name, sha(f.bytes), f.bytes);
  s.db.prepare("DELETE FROM file_store_meta WHERE key LIKE 'profile-assets-migration%'").run();
  assert.throws(() => migrateProfileAssets(s, { fault: (at) => { if (at === 'after-file-0') throw new Error('power cut'); } }), /power cut/);
  assert.equal(s.db.prepare('SELECT count(*) n FROM profile_assets').get().n, 3, 'nothing removed before every file is verified');
  // Meanwhile every asset still reads: the moved one from the store, the others from SQLite.
  assert.equal(s.assets(p.id).length, 3);
  for (const f of files) assert.deepEqual(Buffer.from(s.asset(p.id, f.id).bytes), f.bytes);
  assert.throws(() => migrateProfileAssets(s, { fault: (at) => { if (at === 'before-drop') throw new Error('crash'); } }), /crash/);
  assert.equal(s.db.prepare('SELECT count(*) n FROM resources').get().n, 3);
  const result = migrateProfileAssets(s);
  assert.equal(result.done, true);
  assert.equal(s.db.prepare('SELECT count(*) n FROM profile_assets').get().n, 0);
  assert.equal(readdirSync(join(root, '.studio/profile-assets-migration-backups')).length, 1);
  for (const f of files) assert.deepEqual(Buffer.from(s.asset(p.id, f.id).bytes), f.bytes);
});

test('codexImage maps the app-server imageGeneration item: savedPath, base64 result, usage limit, no image', (t) => {
  const root = studio(t), file = join(root, 'ig.png'), bytes = sheetPng(60, 40);
  writeFileSync(file, bytes);
  const saved = codexImage({ type: 'imageGeneration', id: 'ig_1', status: 'completed', revisedPrompt: 'six ideas', result: '', savedPath: file });
  assert.equal(saved.path, file);
  assert.equal(saved.revisedPrompt, 'six ideas');
  assert.equal(saved.failure, null);
  const inline = codexImage({ type: 'imageGeneration', id: 'ig_2', status: 'completed', revisedPrompt: null, result: bytes.toString('base64') });
  assert.deepEqual(inline.bytes, bytes);
  const limit = codexImage({ type: 'imageGeneration', id: 'ig_3', status: 'failed', result: '', failure: { type: 'usageLimitExceeded', limitId: 'images', resetsAt: 1893456000 } });
  assert.equal(limit.failure.kind, 'usage-limit');
  assert.equal(limit.failure.resetsAt, 1893456000 * 1000, 'seconds become milliseconds');
  assert.match(limit.failure.message, /Image limit reached on your ChatGPT plan\. It resets/);
  assert.match(usageLimitText(null), /Try again later/);
  assert.equal(codexImage({ type: 'imageGeneration', id: 'x', status: 'completed', result: '', savedPath: join(root, 'missing.png') }).failure.kind, 'failed');
});

test('a 3 × 2 sheet is cut into six 16:9 cards; a refinement fills 1280 × 720', async (t) => {
  const root = studio(t), sheet = join(root, 'sheet.png');
  writeFileSync(sheet, sheetPng(960, 540));
  assert.deepEqual(imageSize(sheet), { width: 960, height: 540 });
  const boxes = sheetBoxes(imageSize(sheet), SHEET_GRID);
  assert.equal(boxes.length, 6);
  for (const b of boxes) assert.ok(Math.abs(b.w / b.h - 16 / 9) < 0.03, `box ${b.n} is 16:9`);
  const outs = boxes.map((b) => join(root, 'cells', `${b.n}.png`));
  await cutBoxes(sheet, boxes, outs);
  for (const [i, out] of outs.entries()) assert.deepEqual(imageSize(out), { width: boxes[i].w, height: boxes[i].h });
  // Six different cards (each cell has its own colour).
  assert.equal(new Set(outs.map((o) => sha(readFileSync(o)))).size, 6);
  await fitThumbnail(join(root, 'cells/1.png'), join(root, 'refined.png'));
  assert.deepEqual(imageSize(join(root, 'refined.png')), { width: 1280, height: 720 });
  assert.equal(SHEET_COLOURS.length, 6);
});

test('the board: star, winners (up to 3), one main thumbnail among them, reject, title; PACKAGING.md follows', (t) => {
  const root = studio(t), s = open(t, root);
  const A = s.profile('Alpha'), dir = project(s, root, 'vid', A.id);
  const stored = (n) => { const r = s.files.putBuffer(png(16, 9, () => [n * 40, 0, 0]), { ext: '.png' }); return { sha256: r.sha256, size: r.size, ext: '.png' }; };
  const cards = [1, 2, 3, 4, 5].map((n) => s.addItem('vid', { origin: 'sheet-cell', stored: stored(n), name: `Idea ${n}` }));
  s.mark('vid', cards[0].id, { star: true });
  for (const c of cards.slice(0, MAX_WINNERS)) s.mark('vid', c.id, { winner: true });
  assert.throws(() => s.mark('vid', cards[3].id, { winner: true }), /Up to 3 winners/);
  assert.throws(() => s.mark('vid', cards[3].id, { main: true }), /Up to 3 winners/, 'main needs room among the winners');
  const main = s.mark('vid', cards[1].id, { main: true });
  assert.equal(main.main, cards[1].id);
  s.mark('vid', cards[1].id, { winner: false });
  assert.equal(s.board('vid').main, null, 'taking out the main winner clears the main spot');
  s.mark('vid', cards[2].id, { main: true });
  s.mark('vid', cards[4].id, { rejected: true, note: 'Too busy' });
  assert.throws(() => s.mark('vid', cards[4].id, { winner: true }), /Bring the card back/);
  s.setTitle('vid', '  How I   cut my edit time in half ');
  const b = s.board('vid');
  assert.equal(b.title, 'How I cut my edit time in half');
  assert.equal(b.winners.length, 2);
  assert.equal(b.items.at(-1).id, cards[4].id, 'rejected cards sort last');
  s.writePackaging('vid', dir);
  const md = readFileSync(join(dir, 'packaging/PACKAGING.md'), 'utf8');
  assert.match(md, /Title: How I cut my edit time in half/);
  assert.match(md, /Main thumbnail: thumbnails\/main\.png \(Idea 3\)/);
  assert.match(md, /Rejected: 1[\s\S]*Too busy/);
  assert.deepEqual(JSON.parse(readFileSync(join(dir, 'packaging/packaging.json'), 'utf8')).main, cards[2].id);
  assert.ok(existsSync(join(dir, 'packaging/thumbnails/main.png')));
  // Every card's image counts as used in the Storage report.
  assert.ok(!s.fileReport().unused.some((x) => cards.some((c) => c.hash === x.sha256)));
});

test('fillPostTitle fills only an empty Post title and never overwrites one', async (t) => {
  const root = studio(t), dir = join(root, 'projects', 'vid');
  mkdirSync(join(dir, 'work'), { recursive: true });
  const { fillPostTitle } = await import('../server/packaging.mjs');
  assert.equal(fillPostTitle(dir, 'Vid', 'Chosen title'), 'later', 'no post kit yet: the title waits in PACKAGING.md');
  assert.equal(existsSync(join(dir, 'work/post.json')), false, 'Packaging never starts the post kit (it would mark the Post step done)');
  writeFileSync(join(dir, 'work/post.json'), JSON.stringify({ youtube: { title: '', description: 'd' } }));
  assert.equal(fillPostTitle(dir, 'Vid', 'Chosen title'), 'filled');
  assert.equal(JSON.parse(readFileSync(join(dir, 'work/post.json'), 'utf8')).youtube.title, 'Chosen title');
  assert.equal(fillPostTitle(dir, 'Vid', 'Another title'), 'kept');
  assert.equal(JSON.parse(readFileSync(join(dir, 'work/post.json'), 'utf8')).youtube.title, 'Chosen title');
});
