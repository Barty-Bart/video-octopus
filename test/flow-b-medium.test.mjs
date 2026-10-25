// Flow changes from the UX walkthrough (handoff ux-2026-10-24, TRIAGE §B), medium batch: B1, B3, B4, B6, B9.
//   node --test test/flow-b-medium.test.mjs
// Synthetic temporary studio only: no server, browser, agent, media processing, keys or network.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';

const root = mkdtempSync(join(realpathSync(tmpdir()), 'octopus-flow-bm-'));
const studio = join(root, 'studio'), local = join(root, 'local');
const write = (p, v) => { mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, typeof v === 'string' ? v : JSON.stringify(v, null, 2)); };
const readJ = (p) => JSON.parse(readFileSync(p, 'utf8'));
write(join(local, 'settings.json'), { studio, projectsDir: 'projects' });
process.env.STUDIO_LOCAL_DIR = local;
test.after(() => rmSync(root, { recursive: true, force: true }));
const P = (id) => join(studio, 'projects', id);
const src = (rel) => readFileSync(new URL(`../${rel}`, import.meta.url), 'utf8');
const immediate = () => new Promise((r) => setImmediate(r));

// ---------- B1: Claude's own work is not a change package ----------
const sections = (label = 'Intro') => ({ v: 1, format: 'tutorial', marked: true, blocks: [
  { id: 'intro', type: 'intro', label, order: 1, source: { take: [0, 3] } }, { id: 'main', type: 'body', label: 'Main body', order: 2, source: { take: [3, 9] } }] });
function packageFixture(id) {
  const dir = P(id);
  write(join(dir, 'project.json'), { name: id, type: 'tutorial' });
  write(join(dir, 'work', 'blocks.json'), { v: 1, format: 'tutorial', marked: false, blocks: [{ id: 'take', type: 'body', label: 'Whole take', order: 1, source: { take: [0, 9] } }] });
  return dir;
}
const openChanges = (dir) => (existsSync(join(dir, 'work/notes.json')) ? readJ(join(dir, 'work/notes.json')).notes : []).filter((n) => n.kind === 'change' && n.status === 'open');

test('B1: the window routes that stamp the creator’s edits leave out the read-only rail', async () => {
  const { UI_ROUTES } = await import('../server/package-owner.mjs');
  assert.ok(!UI_ROUTES.includes('/rail'), 'the rail’s "seen" POST is bookkeeping, not an edit');
  for (const r of ['/layout', '/blocks', '/shots', '/zooms']) assert.ok(UI_ROUTES.includes(r), r);
  const idx = src('server/index.mjs');
  assert.match(idx, /UI_ROUTES\.includes\(action\)\) owner\.touch\(id\)/);
  assert.doesNotMatch(idx, /uiTouched/);
  // Every turn's end re-bases the package; the blocks' own settle goes through the server-write hook.
  assert.match(idx, /owner\.afterTurn\(id, dir\)/);
  assert.match(idx, /setServerWriteHook\(/);
  assert.match(src('server/blocks.mjs'), /if \(internal\) serverWrite\(dir, \(\) => save\(dir, doc\)\)/);
});

test('B1: Claude’s sections, its late last write, the rail and a server settle never become a package item; the creator’s edit does', async () => {
  const { makePackageOwner } = await import('../server/package-owner.mjs');
  const { syncDocItems, onProjectFiles } = await import('../server/cutsync.mjs');
  let clock = 1e6, busy = false;
  const notes = [];
  const owner = makePackageOwner({ busy: () => busy, now: () => clock, note: (id, n) => notes.push(n.text), settle: () => {} });
  const watcher = (id, dir) => { owner.onDocFiles(id, dir); return onProjectFiles(dir, ['work/blocks.json']); };

  // Claude's Split into sections while its turn runs: the base moves with it.
  const a = packageFixture('b1-busy');
  syncDocItems(a); // first sight: the package's starting point
  busy = true; write(join(a, 'work/blocks.json'), sections());
  clock += 700; assert.deepEqual(watcher('b1-busy', a), []);
  busy = false; owner.afterTurn('b1-busy', a);
  assert.deepEqual(openChanges(a), []);

  // Its last write reaches the watcher after busy went false (0.7 s debounce): still Claude's.
  const b = packageFixture('b1-late');
  syncDocItems(b);
  busy = true; clock += 10000; busy = false;
  write(join(b, 'work/blocks.json'), sections());
  owner.afterTurn('b1-late', b); // the end of the turn re-bases on what is there
  clock += 700; assert.deepEqual(watcher('b1-late', b), []);
  const c = packageFixture('b1-late2');
  syncDocItems(c);
  owner.afterTurn('b1-late2', c); // the turn ended before the write landed on disk
  write(join(c, 'work/blocks.json'), sections());
  clock += 700; assert.deepEqual(watcher('b1-late2', c), []);
  assert.deepEqual(openChanges(c), []);

  // The page’s rail "seen" POST no longer stamps the project, so nothing makes Claude’s write look like the creator’s.
  const d = packageFixture('b1-rail');
  syncDocItems(d);
  clock += 10000; busy = true; write(join(d, 'work/blocks.json'), sections()); // (/rail seen arrives here: not stamped)
  clock += 700; assert.deepEqual(watcher('b1-rail', d), []);
  busy = false; owner.afterTurn('b1-rail', d);
  assert.deepEqual(openChanges(d), []);

  // Video Octopus settles rule blocks after the turn (a GET reads the row): its own write isn't the creator's.
  clock += 30000;
  owner.serverWrite('b1-rail', d, () => write(join(d, 'work/blocks.json'), sections('Intro (placed)')));
  clock += 700; assert.deepEqual(watcher('b1-rail', d), []);
  assert.deepEqual(openChanges(d), []);

  // The creator renames a block in the window: that one is theirs, with one line in the chat.
  owner.touch('b1-rail'); write(join(d, 'work/blocks.json'), sections('My intro'));
  clock += 700;
  const made = watcher('b1-rail', d);
  assert.equal(made.length, 1);
  assert.match(made[0].text, /renamed “Intro \(placed\)” → “My intro”/);
  // A settle right after it keeps the creator's change in the package (synced first, the base keeps its start).
  clock += 200;
  owner.serverWrite('b1-rail', d, () => write(join(d, 'work/blocks.json'), sections('My intro')));
  assert.equal(openChanges(d).length, 1);

  // A creator's edit the watcher hasn't seen yet when a settle comes: it goes in first, not lost.
  const e = packageFixture('b1-pending');
  syncDocItems(e);
  clock += 30000; owner.touch('b1-pending'); write(join(e, 'work/blocks.json'), sections('Mine'));
  owner.serverWrite('b1-pending', e, () => {});
  assert.equal(openChanges(e).length, 1);
  assert.ok(notes.some((t) => /Mine/.test(t)));
});

test('B1: the change package count stays one number (A4) and is 0 after Claude’s own turn', async () => {
  const { scenesSummary } = await import('../server/scenes.mjs');
  const { makePackageOwner } = await import('../server/package-owner.mjs');
  const { syncDocItems, onProjectFiles } = await import('../server/cutsync.mjs');
  const dir = packageFixture('b1-count');
  write(join(dir, 'work/production.json'), { scenes: [{ id: '1', start: 0, end: 3, line: 'Hi' }] });
  syncDocItems(dir);
  let busy = true;
  const owner = makePackageOwner({ busy: () => busy });
  write(join(dir, 'work/blocks.json'), sections());
  owner.onDocFiles('b1-count', dir); onProjectFiles(dir, ['work/blocks.json']);
  busy = false; owner.afterTurn('b1-count', dir);
  assert.equal(scenesSummary(dir).open, 0);
  // The page's scenes panel counts open items + new moves, the server the same: the dock reads the panel's (web/app.js).
  assert.match(src('web/scenes.js'), /const packageCount = \(\) => openItems\(\)\.length \+ newMoveList\(\)\.length;/);
  assert.match(src('web/app.js'), /One count for the change package: the Scenes panel's, also on the dock and the stage list \(A4\)/);
});

test('B1: a step whose result is in the window’s files gets Undo (one level); Clean up and Lock don’t', async () => {
  const { trackTurns, undoTurn, stepUndoable, WINDOW_FILES } = await import('../server/turns.mjs');
  const PIPE = JSON.parse(src('core/pipelines.json'));
  const shared = (k) => ({ id: k, ...PIPE.shared[k] });
  assert.equal(stepUndoable(shared('sections')), true);
  assert.equal(stepUndoable(shared('prepare')), false);
  assert.equal(stepUndoable(shared('lock')), false);
  assert.equal(stepUndoable(PIPE.formats.tutorial.steps.find((s) => s.id === 'plan')), true);
  assert.equal(stepUndoable(PIPE.formats.tutorial.steps.find((s) => s.id === 'intro')), false);
  assert.ok(WINDOW_FILES.includes('post.md'));

  const id = 'b1-undo', dir = packageFixture(id);
  const before = readFileSync(join(dir, 'work/blocks.json'), 'utf8');
  const broadcasts = [], notes = [];
  const chat = { listeners: new Set(), busy: false, emit(ev) { for (const l of this.listeners) l(ev); }, setBusy(b) { this.busy = b; this.emit({ t: 'busy', busy: b }); }, addStudioNote(n) { notes.push(n); } };
  trackTurns(id, chat, { broadcast: (ev) => broadcasts.push(ev) });
  const run = async (brief, edit) => {
    chat.emit({ t: 'user', text: 'Mark the sections…', brief });
    chat.setBusy(true); edit(); chat.emit({ t: 'result', ok: true }); chat.setBusy(false); await immediate(); await immediate();
  };
  await run({ name: 'Split into sections', step: 'sections' }, () => write(join(dir, 'work/blocks.json'), sections()));
  const offer = broadcasts.find((e) => e.t === 'undo-offer');
  assert.ok(offer, 'Split into sections gets Undo');
  assert.equal(offer.step, 'Split into sections');
  assert.deepEqual(offer.files, ['work/blocks.json']);
  const r = undoTurn(id, offer.id, chat);
  assert.equal(readFileSync(join(dir, 'work/blocks.json'), 'utf8'), before);
  assert.match(r.note, /^Undone Split into sections/);
  assert.match(notes[0], /Undo on your last step \(Split into sections\)/);
  // Clean up (its files are outside the window's list) gets none.
  const n = broadcasts.length;
  await run({ name: 'Clean up', step: 'prepare' }, () => write(join(dir, 'work/blocks.json'), sections('Other')));
  assert.equal(broadcasts.slice(n).some((e) => e.t === 'undo-offer'), false);
  // The page names the step on the quick reply.
  assert.match(src('web/app.js'), /undo\.step \? `Undo \$\{undo\.step\}`/);
});
