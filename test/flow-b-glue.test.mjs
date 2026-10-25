// Flow changes, final batch (handoff flow-b-final-2026-10-25): the glue between the parallel batches: B6's notes as
// B10's "finished with open items", the dock while a take records, the top bar badge, and B4 + a learned format's plan
// approval as one decision.
//   node --test test/flow-b-glue.test.mjs
// Synthetic temporary studio only: no server, browser, agent, media processing, keys or network.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';

const root = mkdtempSync(join(realpathSync(tmpdir()), 'octopus-flow-glue-'));
const studio = join(root, 'studio'), local = join(root, 'local');
const write = (p, v) => { mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, typeof v === 'string' ? v : JSON.stringify(v, null, 2)); };
const readJ = (p) => JSON.parse(readFileSync(p, 'utf8'));
write(join(local, 'settings.json'), { studio, projectsDir: 'projects' });
process.env.STUDIO_LOCAL_DIR = local;
test.after(() => rmSync(root, { recursive: true, force: true }));
const P = (id) => join(studio, 'projects', id);
const src = (rel) => readFileSync(new URL(`../${rel}`, import.meta.url), 'utf8');

function planFixture(id, { scenes } = {}) {
  const dir = P(id);
  write(join(dir, 'project.json'), { name: id, type: 'tutorial' });
  write(join(dir, 'source', 'take_webcam.mp4'), 'synthetic');
  write(join(dir, 'work', 'tr', 'words.json'), [[0.5, 0.9, 'Hello'], [1, 1.4, 'there.'], [3, 3.5, 'Bye.']]);
  write(join(dir, 'work', 'joins.json'), { joins: [], summary: { joins: 0, likely_clipped: 0 } });
  write(join(dir, 'work', 'edl_fixed.json'), { segments_sec: [[0.4, 1.5], [2.9, 3.6]] });
  write(join(dir, 'work', 'blocks.json'), { v: 1, marked: true, blocks: [{ id: 'intro', type: 'intro', label: 'Intro', order: 1 }, { id: 'main', type: 'body', label: 'Main body', order: 2 }] });
  write(join(dir, 'WORKLOG.md'), '- Cut locked (join-check: 0 joins, 0 clipped)\n');
  write(join(dir, 'work', 'production.json'), { scenes: scenes || [
    { id: 1, block: 'intro', start: 0, end: 1, line: 'Hello there.', status: 'planned' },
    { id: 2, block: 'intro', start: 1, end: 2, line: 'More.', status: 'planned' },
    { id: 3, block: 'main', start: 2, end: 3, line: 'Body.', status: 'planned' },
    { id: 4, block: 'main', start: 3, end: 4, line: 'Bye.', status: 'planned' }] });
  return dir;
}
const setStatus = (dir, map) => { const f = join(dir, 'work/production.json'), p = readJ(f); for (const s of p.scenes) if (map[s.id]) s.status = map[s.id]; write(f, p); };

// ---------- B6 → B10: the notes Save changes → Claude left open are Claude's open items ----------
test('B6 → B10: "Claude finished · 1 still open" in the badge, the dock line, the rail mark and the tab title', async () => {
  const A = await import('../web/attention.js');
  const id = 'p-notes';
  A.openItems(id, 'notes', { count: 1, text: '2 notes done, 1 still open' });
  const st = A.stateOf(id), d = A.describe(st, 'Claude');
  assert.equal(st.state, 'open');
  assert.deepEqual([d.badge, d.line, d.mark, d.title], ['Claude finished · 1 still open', 'Claude finished', 'open', '(1) ']);
  assert.match(d.label, /Claude finished, with this left for you: 2 notes done, 1 still open/);
  assert.equal(A.titleFor('Weekly tips · Video Octopus', st).title, '(1) Weekly tips · Video Octopus');
  // Working and waiting still win over it; taking it away leaves Claude idle.
  A.setWorking(id, true);
  assert.equal(A.stateOf(id).state, 'working');
  A.setWorking(id, false);
  A.openItems(id, 'notes', null);
  assert.equal(A.stateOf(id).state, 'idle');
});

test('B6 → B10: the project view counts the sent notes still open now (read live), and the rail reports them', async () => {
  const { packageRunView, notesOp } = await import('../server/scenes.mjs');
  const dir = planFixture('b6-left');
  write(join(dir, 'work', 'notes.json'), { v: 1, notes: [
    { id: 'n1', scene: '1', text: 'a', status: 'done' }, { id: 'n2', scene: '2', text: 'b', status: 'done' }, { id: 'n3', scene: '3', text: 'c', status: 'question' }] });
  assert.equal(packageRunView(dir, null), null);
  assert.deepEqual(packageRunView(dir, { at: 5, ids: ['n1', 'n2', 'n3'], started: true }), { at: 5, result: null, left: null }, 'nothing until the turn ended');
  const run = { at: 5, ids: ['n1', 'n2', 'n3'], result: { sent: 3, done: 2, open: 1, text: 'Claude finished · 2 notes done, 1 still open' } };
  assert.deepEqual(packageRunView(dir, run).left, { open: 1, unmarked: 0, count: 1, text: '2 notes done, 1 still open' });
  // The creator deals with the open one: nothing is left.
  const doc = readJ(join(dir, 'work/notes.json')); doc.notes[2].status = 'resolved'; write(join(dir, 'work/notes.json'), doc);
  assert.equal(packageRunView(dir, run).left.count, 0);
  assert.equal(typeof notesOp, 'function');
  const rail = src('web/rail.js'), app = src('web/app.js'), idx = src('server/index.mjs');
  assert.match(idx, /packageRun: packageRunView\(dir, state\(\)\.projects\?\.\[id\]\?\.packageRun\)/);
  assert.match(rail, /openItems\(id, 'notes', nl \? \{ count: nl\.count, text: nl\.text, read: \(\) => hooks\.openNotes\?\.\(\) \} : null\)/);
  assert.match(rail, /store\.set\(`vo\.notesSeen\.\$\{id\}`, String\(at\)\)/, '× puts them away for that Save');
  assert.match(app, /openNotes: \(\) => \{ setTab\('scenes', 'Polish'\); scenes\.showNotes\(\); \}/);
  assert.match(src('web/scenes.js'), /showPlan, showNotes,/);
});

// ---------- the dock while a take records ----------
test('Recording: the dock shows the take ("Recording 0:42 · Stop") instead of Record · Start, and Record never opens a second start', () => {
  const rail = src('web/rail.js'), app = src('web/app.js');
  assert.match(rail, /const rec = !green && !rs && cur\?\.action === 'import' \? hooks\.recording\?\.\(\) \|\| null : null;/);
  assert.match(rail, /mode = green \? 'done' : rs \? 'run' : rec \? 'rec' : cur \? 'next' : 'all'/);
  assert.match(rail, /data-a="rec-stop" aria-label="Stop the take"/);
  assert.match(rail, /case 'rec-stop': return hooks\.stopRecording\?\.\(\);/);
  assert.match(rail, /\{ live: 'Recording', paused: 'Paused', starting: 'Starting the take…', saving: 'Saving the take…' \}/);
  assert.match(app, /recording: \(\) => recordingHere\(\), stopRecording: \(\) => \{ if \(rec\.session\(\)\.phase === 'recording'\) rec\.stop\(\); \}/);
  assert.match(app, /const offRecDock = rec\.onSession\(\(\) => rail\.render\(\)\);/);
  assert.match(app, /if \(s\.kind === 'app' && s\.action === 'import'\) \{ setTab\('canvas', s\.stage\); if \(!recordingHere\(\)\) canvas\.showImport\(\); return; \}/);
});
test('Recording: what the dock reads from the session (rec-live.js liveMode)', async () => {
  const { liveMode } = await import('../web/rec-live.js');
  assert.equal(liveMode({ phase: 'recording', project: 'a', paused: false }, { id: 'a' }), 'live');
  assert.equal(liveMode({ phase: 'recording', project: 'a', paused: true }, { id: 'a' }), 'paused');
  assert.equal(liveMode({ phase: 'recording', project: 'b' }, { id: 'a' }), null, 'a take for another video leaves this dock alone');
  assert.equal(liveMode({ phase: 'saving', project: 'a' }, { id: 'a' }), 'saving');
});

// ---------- the top bar: the badge folds to a dot before the style picker is squeezed ----------
test('Top bar: Claude’s badge folds to a dot (tooltip and name keep the words) when the bar is short of room', () => {
  const rail = src('web/rail.js'), app = src('web/app.js'), css = src('web/style.css');
  assert.match(rail, /badge\.classList\.add\('dot'\);\n\s+place\(\);/);
  assert.match(rail, /Number\(barHost\.dataset\.fit\) >= 2 \|\| squeezed\(\)/);
  assert.match(app, /waitBadge\.setAttribute\('aria-label', d\.label \|\| d\.badge\);/);
  assert.match(app, /rail\?\.fit\(\); \/\/ the bar fits again/);
  assert.match(css, /\.wait-badge\.dot span \{ display: none; \}/);
  assert.match(css, /\.bar:has\(\.wait-badge:not\(\[hidden\]\)\) \.bar-actions kbd \{ display: none; \}/);
});

// ---------- B4 + a learned format: one approval ----------
test('B4 + learned format: the plan token ignores "approved" and build status; a changed scene or cut makes it stale', async () => {
  const { planToken, legacyPlanToken, learnedPlanApproval, pipelineStatus, saveProjectMeta } = await import('../server/studio.mjs');
  const plan = { scenes: [{ id: 1, line: 'a', status: 'planned' }] }, cut = { file: 'work/edl_fixed.json', segments: [[0, 1]] };
  const t = planToken(plan, cut, 'v1');
  assert.equal(planToken({ ...plan, approved: { at: 'x' } }, cut, 'v1'), t, 'Approve plan does not change it');
  assert.equal(planToken({ scenes: [{ id: 1, line: 'a', status: 'built' }] }, cut, 'v1'), t, 'Build’s marks do not change it');
  assert.notEqual(planToken({ scenes: [{ id: 1, line: 'b' }] }, cut, 'v1'), t, 'a changed scene does');
  assert.notEqual(planToken(plan, { ...cut, segments: [[0, 2]] }, 'v1'), t, 'a changed cut does');
  assert.notEqual(planToken(plan, cut, 'v2'), t, 'another guide version does');

  const dir = planFixture('b4-learned');
  assert.equal(learnedPlanApproval(dir), null, 'not a learned format: nothing to check');
  saveProjectMeta(dir, { learning: { versionId: 'v1', profileId: 'p', formatId: 'f' } });
  let a = learnedPlanApproval(dir);
  assert.equal(a.ok, false);
  // Approve plan (B4) without the learned approval: the dock says Approve the plan again, with why.
  const { approvePlan, planState } = await import('../server/scenes.mjs');
  approvePlan(dir);
  let plan2 = pipelineStatus(dir, 'tutorial').steps.find((s) => s.id === 'plan');
  assert.deepEqual([plan2.done, plan2.awaiting, plan2.again, plan2.name], [false, 'approve', true, 'Approve the plan']);
  assert.match(plan2.what, /changed since you approved it/);
  assert.equal(planState(dir).again, true);
  // The learned approval recorded with it (what /plan approve does through learning.mjs approveLearnedPlan).
  saveProjectMeta(dir, { learning: { versionId: 'v1', profileId: 'p', formatId: 'f', planApproval: learnedPlanApproval(dir).token } });
  plan2 = pipelineStatus(dir, 'tutorial').steps.find((s) => s.id === 'plan');
  assert.deepEqual([plan2.done, plan2.again], [true, undefined]);
  assert.equal(planState(dir).again, undefined);
  // Build marks scenes: still approved. Claude changes a scene: stale again.
  setStatus(dir, { 1: 'building', 2: 'built' });
  assert.equal(learnedPlanApproval(dir).ok, true);
  const f = join(dir, 'work/production.json'), p = readJ(f); p.scenes[0].line = 'Changed.'; write(f, p);
  assert.equal(learnedPlanApproval(dir).ok, false);
  assert.equal(pipelineStatus(dir, 'tutorial').current, 'plan');
  // A video already built stays done (nothing reopens); the next Build's guard asks for the approval instead.
  write(join(dir, 'renders', 'b4-learned_intro_v1.mp4'), 'synthetic');
  assert.equal(pipelineStatus(dir, 'tutorial').steps.find((s) => s.id === 'plan').done, true);
  // An approval made before this rule (the sheet's raw bytes) still holds while the bytes are the same.
  const raw = readFileSync(f), cut2 = (await import('../server/studio.mjs')).lockedCut(dir);
  saveProjectMeta(dir, { learning: { versionId: 'v1', profileId: 'p', formatId: 'f', planApproval: legacyPlanToken(raw, cut2, 'v1') } });
  assert.equal(learnedPlanApproval(dir).ok, true);
});
test('B4 + learned format: approveLearnedPlan records the approval in the project and the database; unapprove takes it back', async () => {
  const dir = planFixture('b4-learned-db');
  const { saveProjectMeta, learnedPlanApproval, projectMeta } = await import('../server/studio.mjs');
  saveProjectMeta(dir, { learning: { versionId: 'v9', profileId: 'p', formatId: 'f' } });
  const L = await import('../server/learning.mjs');
  assert.equal(learnedPlanApproval(dir).ok, false);
  assert.equal(L.approveLearnedPlan('b4-learned-db', dir), true);
  assert.equal(learnedPlanApproval(dir).ok, true);
  assert.equal(projectMeta(dir).learning.planApproval, learnedPlanApproval(dir).token);
  assert.equal(L.learnedPlan('b4-learned-db', dir).approved, true, 'the Build guard reads the same approval');
  assert.equal(L.unapproveLearnedPlan('b4-learned-db', dir), true);
  assert.equal(learnedPlanApproval(dir).ok, false);
  assert.equal(L.approveLearnedPlan('b6-left', P('b6-left')), false, 'not a learned format: nothing to record');
});
test('B4 + learned format: Approve plan records the learned approval too, Ask for changes takes it back, and the guard points to Plan', () => {
  const idx = src('server/index.mjs'), learning = src('server/learning.mjs');
  assert.match(idx, /try \{ approveLearnedPlan\(id, dir\); \} catch/);
  assert.match(idx, /try \{ unapproveLearnedPlan\(id, dir\); \} catch \{\}/);
  assert.match(learning, /export function approveLearnedPlan\(id,dir\)/);
  assert.match(learning, /Approve the plan in the Plan stage before building/);
  assert.match(learning, /try\{approvePlan\(dir\);\}catch\{\}/, 'the learned panel’s approval is Approve plan too');
  assert.match(src('web/scenes.js'), /again \? 'Approve plan again' : 'Approve plan'/);
});
