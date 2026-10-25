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

// ---------- B3: a locked cut looks locked ----------
function cutFixture(id) {
  const dir = P(id);
  write(join(dir, 'project.json'), { name: id, type: 'tutorial' });
  write(join(dir, 'source', 'take_webcam.mp4'), 'synthetic');
  write(join(dir, 'work', 'tr', 'words.json'), [[0.5, 0.9, 'Hello'], [1, 1.4, 'there.'], [3, 3.5, 'Bye.']]);
  write(join(dir, 'work', 'joins.json'), { joins: [{ k: 0, src_out: 1.5, src_in: 2.9, status: 'likely clipped' }], summary: { joins: 1, likely_clipped: 1 } });
  write(join(dir, 'work', 'edl_fixed.json'), { segments_sec: [[0.4, 1.5], [2.9, 3.6]] });
  write(join(dir, 'work', 'blocks.json'), { v: 1, marked: true, blocks: [] });
  return dir;
}
const lockStep = async (dir) => (await import('../server/studio.mjs')).pipelineStatus(dir, 'tutorial');

test('B3: a locked cut is read-only; Unlock is explicit, the Lock step is next again, and a new lock holds again', async () => {
  const { lockState, cutReadOnly, lockHeld, unlockCut, cutReview } = await import('../server/cutreview.mjs');
  const dir = cutFixture('b3-lock');
  assert.equal(cutReadOnly(dir), false, 'not locked yet: editable');
  assert.equal(unlockCut(dir), false, 'nothing to unlock');
  write(join(dir, 'WORKLOG.md'), '# Worklog\n- 2026-10-25: Cut locked (join-check: 1 joins, 0 clipped)\n');
  let st = await lockStep(dir);
  assert.equal(st.steps.find((s) => s.id === 'lock').done, true);
  assert.equal(cutReadOnly(dir), true);
  assert.equal(cutReview(dir).locked, true);
  assert.equal(lockHeld(dir), true);

  assert.equal(unlockCut(dir), true);
  assert.deepEqual(lockState(dir), { locked: true, changed: false, unlocked: true });
  assert.equal(cutReadOnly(dir), false);
  assert.equal(lockHeld(dir), false, 'learning: planning and building wait for the next lock');
  st = await lockStep(dir);
  const lock = st.steps.find((s) => s.id === 'lock');
  assert.equal(lock.done, false); assert.equal(lock.unlocked, true);
  assert.equal(st.current, 'lock', 'Lock the cut is the next step again');
  const log = readFileSync(join(dir, 'WORKLOG.md'), 'utf8');
  assert.match(log, /Cut unlocked/);
  assert.equal((log.match(/Cut locked/g) || []).length, 1, '"Cut unlocked" is not counted as a lock');
  assert.doesNotMatch(log.split('\n').at(-2), /Cut locked/i, 'learning keys on "Cut locked": the unlock line never matches it');

  // Claude locks again: a new "Cut locked" line, read-only again.
  write(join(dir, 'WORKLOG.md'), `${log}- 2026-10-25: Cut locked (join-check: 1 joins, 0 clipped)\n`);
  assert.equal(cutReadOnly(dir), true);
  assert.equal((await lockStep(dir)).steps.find((s) => s.id === 'lock').done, true);
});

test('B3: while locked the Cut Editor’s save and Scenes’ cut save are refused, and the page knows', async () => {
  const { cutEditorRoute } = await import('../server/cuteditor.mjs');
  const { LOCKED_ERROR } = await import('../server/cutreview.mjs');
  const dir = cutFixture('b3-save');
  write(join(dir, 'WORKLOG.md'), '- Cut locked (join-check: 1 joins, 0 clipped)\n');
  let sent = null;
  const send = (res, code, b) => { sent = { code, b }; };
  const answered = await cutEditorRoute({ method: 'POST' }, {}, { dir, what: 'save', send, body: async () => ({ segments: [[0.4, 1]], version: 0 }), serveFile: () => {} });
  assert.equal(answered, true);
  assert.equal(sent.code, 409); assert.equal(sent.b.locked, true); assert.equal(sent.b.error, LOCKED_ERROR);
  assert.equal(existsSync(join(dir, 'work/edl_manual.json')), false);
  // Keep / Cut decisions in the list are refused too (they are edits).
  const { cutReviewRoute } = await import('../server/cutreview.mjs');
  await cutReviewRoute({ method: 'POST' }, {}, { dir, action: '/cut-review', send, body: async () => ({ decisions: { c1: 'cut' } }) });
  assert.equal(sent.code, 409);
  const idx = src('server/index.mjs');
  assert.match(idx, /action === '\/cut-save'\) \{\n    if \(cutReadOnly\(dir\)\) return send\(res, 409/);
  assert.match(idx, /joins: cutReadOnly\(dir\) \? \[\] : joinFlags\(dir\)/, 'no join flags on the canvas timeline while locked');
  // The editor page: data.json says locked; edits, undo, autosave and saves stop; flagged joins aren't drawn.
  assert.match(src('server/cuteditor.mjs'), /version: version\(dir, plan\), locked: cutReadOnly\(dir\)/);
  const page = src('web/cut-editor/index.html');
  for (const re of [/function cut\(a,b\)\{if\(ro\(\)/, /function restore\(a,b\)\{if\(ro\(\)/, /function razor\(\)\{if\(ro\(\)\)return;/, /async function autoTick\(\)\{if\(!D\|\|autoBusy\|\|RO\)return;/,
    /async function save\(force,auto\)\{if\(RO\)/, /for\(const j of \(RO\?\[\]:D\.joins\|\|\[\]\)\)/, /if\(d\.locked\)setRO\(true\)/, /Unlock to edit/]) assert.match(page, re);
  assert.match(src('web/cut-editor/studio.js'), /if\(m\.type==='studio:lock'\)\{setRO\(m\.locked\);return\}/);
  // The inspector: Unlock to edit, no "Joins to check" while locked.
  const panel = src('web/cutpanel.js');
  assert.match(panel, /data-a="unlock">Unlock to edit<\/button>/);
  assert.match(panel, /\$\{isLocked\(\) \? '' : `<li><i class="sw tri"/);
  assert.match(panel, /op: 'unlock'/);
});

// ---------- B4: Plan has Approve ----------
function planFixture(id) {
  const dir = cutFixture(id);
  write(join(dir, 'WORKLOG.md'), '- Cut locked (join-check: 1 joins, 0 clipped)\n');
  write(join(dir, 'work', 'production.json'), { scenes: [{ id: '1', start: 0, end: 1, line: 'Hello there.', visual: 'Me, full frame' }, { id: '2', start: 1, end: 2, line: 'Bye.', layout: 'split' }] });
  return dir;
}

test('B4: a written plan waits for Approve plan; Build is next only after it; a video built before still counts as approved', async () => {
  const { pipelineStatus, listProjects } = await import('../server/studio.mjs');
  const { approvePlan, unapprovePlan, planState, scenesView, notesOp } = await import('../server/scenes.mjs');
  const dir = planFixture('b4-plan');
  let st = pipelineStatus(dir, 'tutorial');
  let plan = st.steps.find((s) => s.id === 'plan');
  assert.equal(plan.done, false);
  assert.equal(plan.awaiting, 'approve');
  assert.equal(st.current, 'plan');
  assert.deepEqual([plan.name, plan.kind, plan.action], ['Approve the plan', 'app', 'open-plan']);
  assert.equal(listProjects().find((p) => p.id === 'b4-plan').next, 'Approve the plan');
  assert.equal(planState(dir).approved, null);

  const a = approvePlan(dir);
  assert.equal(a.by, 'creator');
  st = pipelineStatus(dir, 'tutorial');
  plan = st.steps.find((s) => s.id === 'plan');
  assert.equal(plan.done, true); assert.equal(plan.name, 'Plan the scenes'); assert.equal(plan.awaiting, undefined);
  assert.equal(st.current, 'intro', 'Build the intro is next only after the approval');
  assert.match(readFileSync(join(dir, 'WORKLOG.md'), 'utf8'), /Plan approved in Video Octopus \(2 scenes\)/);
  assert.doesNotMatch(readFileSync(join(dir, 'WORKLOG.md'), 'utf8'), /Scenes approved/, 'not the Polish review line');
  assert.ok(scenesView(dir).plan.approved.at);

  assert.equal(unapprovePlan(dir), true);
  assert.equal(pipelineStatus(dir, 'tutorial').current, 'plan');
  // A video built before plans needed approval (a render of a Build step): the plan counts as approved, nothing reopens.
  write(join(dir, 'renders', 'b4-plan_intro_v1.mp4'), 'synthetic');
  assert.equal(pipelineStatus(dir, 'tutorial').steps.find((s) => s.id === 'plan').done, true);
  // No sheet at all: Plan the scenes is a Claude step as before.
  const empty = cutFixture('b4-empty');
  write(join(empty, 'WORKLOG.md'), '- Cut locked\n');
  const e = pipelineStatus(empty, 'tutorial').steps.find((s) => s.id === 'plan');
  assert.deepEqual([e.done, e.name, e.kind, e.awaiting], [false, 'Plan the scenes', 'claude', undefined]);
  // Per-scene Approve in Polish is separate and still refused for an unbuilt scene.
  const fresh = planFixture('b4-polish');
  assert.throws(() => notesOp(fresh, { op: 'approve', scene: '1' }), /isn't built yet/);
  assert.equal(pipelineStatus(fresh, 'tutorial').steps.find((s) => s.id === 'plan').done, false);
});

test('B4: only the creator approves: an approval Claude writes comes out, one pressed while Claude works stays', async () => {
  const { trackTurns, keepInTurn, unfinishedOf } = await import('../server/turns.mjs');
  const { approvePlan } = await import('../server/scenes.mjs');
  const { pipelineStatus } = await import('../server/studio.mjs');
  const mk = (id) => {
    const dir = planFixture(id), events = [], notes = [];
    const chat = { listeners: new Set(), busy: false, emit(ev) { events.push(ev); for (const l of this.listeners) l(ev); }, setBusy(b) { this.busy = b; this.emit({ t: 'busy', busy: b }); }, addStudioNote(n) { notes.push(n); } };
    trackTurns(id, chat, { broadcast: () => {} });
    return { dir, chat, events, notes };
  };
  const turn = async (f, brief, during) => { f.chat.emit({ t: 'user', text: 'Plan…', ...(brief ? { brief } : {}) }); f.chat.setBusy(true); during(); f.chat.emit({ t: 'result', ok: true }); f.chat.setBusy(false); await immediate(); await immediate(); };
  const sheet = (dir) => readJ(join(dir, 'work/production.json'));

  const a = mk('b4-claude');
  await turn(a, { name: 'Plan the scenes', step: 'plan' }, () => write(join(a.dir, 'work/production.json'), { ...sheet(a.dir), approved: { at: '2026-10-25T00:00:00Z', by: 'creator' } }));
  assert.equal(sheet(a.dir).approved, undefined);
  assert.ok(a.events.some((e) => e.t === 'note' && /waits for your approval/.test(e.text)));
  assert.match(a.notes.join(' '), /only the creator approves the plan/);
  // The plan step's turn ended with its sheet: waiting for the creator, not "Didn't finish".
  assert.equal(unfinishedOf('b4-claude', pipelineStatus(a.dir, 'tutorial')), null);

  const b = mk('b4-creator');
  await turn(b, null, () => { const approved = approvePlan(b.dir); keepInTurn('b4-creator', 'work/production.json', { approved }); });
  assert.equal(sheet(b.dir).approved.by, 'creator', 'pressed in the window during the turn: kept');
  // Claude keeping the creator's approval while it edits the sheet: kept.
  await turn(b, null, () => write(join(b.dir, 'work/production.json'), { ...sheet(b.dir), theme: 'warm' }));
  assert.equal(sheet(b.dir).approved.by, 'creator');
});

test('B4: the Plan panel, the dock’s Approve the plan and the asks that say "and stop"', async () => {
  const PIPE = JSON.parse(src('core/pipelines.json'));
  for (const [f, v] of Object.entries(PIPE.formats)) {
    const plan = v.steps.find((s) => s.id === 'plan');
    assert.deepEqual(plan.done, { json: ['work/production.json', 'approved'], built: true }, f);
    assert.match(plan.ask, /tell me about it and stop/, f);
    assert.match(plan.ask, /never set "approved" in the sheet yourself/, f);
  }
  const scenes = src('web/scenes.js');
  for (const re of [/data-a="approve-plan"/, />Approve plan<\/button>/, /data-a="ask-plan">Ask for changes<\/button>/, /<i>On screen<\/i>/, /op: 'changes', text/]) assert.match(scenes, re);
  assert.match(src('web/app.js'), /s\.action === 'open-plan'\) \{ setTab\('scenes', 'Plan'\); scenes\.showPlan\(\); return; \}/);
  const idx = src('server/index.mjs');
  assert.match(idx, /if \(action === '\/plan'\)/);
  assert.match(idx, /Changes to the scene plan: \$\{text\}/);
  assert.match(idx, /never write or change that key yourself/);
  assert.match(src('starter/.claude/skills/production-sheet/SKILL.md'), /Never add or change that key yourself/);
});

// ---------- B6: Polish: Approve always visible, and a "finished" summary ----------
test('B6: after Save changes → Claude, the items it sent are counted: done, still open, not marked done', async () => {
  const { packageResult, packageResultText, applyBrief } = await import('../server/scenes.mjs');
  const dir = planFixture('b6-notes');
  const note = (id, extra = {}) => ({ id, scene: '1', text: `Note ${id}`, status: 'open', t: 0.5, ...extra });
  write(join(dir, 'work/notes.json'), { v: 1, notes: [note('a'), note('b'), note('c'), note('old', { status: 'done' })], approved: {} });
  const brief = applyBrief(dir);
  assert.deepEqual(brief.ids, ['a', 'b', 'c'], 'Save says which items it sent');
  // Claude marks one done, asks about one, and leaves one as "sent".
  const doc = readJ(join(dir, 'work/notes.json'));
  doc.notes.find((n) => n.id === 'a').status = 'done';
  doc.notes.find((n) => n.id === 'b').status = 'question';
  write(join(dir, 'work/notes.json'), doc);
  const r = packageResult(dir, brief.ids);
  assert.deepEqual([r.sent, r.done, r.open, r.unmarked], [3, 1, 1, 1]);
  assert.equal(r.text, 'Claude finished · 1 note done, 1 still open, 1 note not marked done');
  assert.equal(packageResultText({ done: 2, open: 1 }), 'Claude finished · 2 notes done, 1 still open');
  assert.equal(packageResultText({ done: 2, unmarked: 1 }), 'Claude finished · 2 notes done, 1 note not marked done');
  assert.equal(packageResultText({ done: 3 }), 'Claude finished · 3 notes done');
  assert.equal(packageResultText({ done: 1, noun: 'change' }), 'Claude finished · 1 change done');
  // The server keeps the run (apply-notes) and counts it when the turn after it ends; the page shows it in the panel.
  const idx = src('server/index.mjs');
  assert.match(idx, /setProjectState\(id, \{ packageRun: brief\.ids\?\.length \? \{ ids: brief\.ids, at: Date\.now\(\), started: false \} : null \}\)/);
  assert.match(idx, /const result = packageResult\(dir, run\.ids\);/);
  assert.match(idx, /packageRun: \(\(\{ at, result \} = \{\}\)/);
  assert.match(src('web/scenes.js'), /class="s2-fin\$\{fin\.open \|\| fin\.unmarked \? ' open' : ''\}" role="status">\$\{esc\(fin\.text\)\}/);
});

test('B6: Approve scene stays on the scene; an unbuilt scene shows a disabled "Build first"', () => {
  const scenes = src('web/scenes.js');
  assert.match(scenes, /<button class="btn small s2-approve" id="scApprove" type="button"><\/button>/);
  assert.match(scenes, /b\.disabled = !built && !ok;/);
  assert.match(scenes, /b\.textContent = ok \? 'Approved ✓' : built \? 'Approve scene' : 'Build first';/);
  assert.doesNotMatch(scenes, /id="ncApprove"/, 'not hidden behind the Notes tab any more');
  assert.match(src('test/scenes.e2e.mjs'), /nb\.approve\.text === 'Build first'/);
});
