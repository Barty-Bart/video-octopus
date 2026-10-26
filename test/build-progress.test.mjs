// B5b (handoff flow-b-final-2026-10-25): Build's progress per scene, from the production sheet's marks (sheet.py mark)
// and one-scene previews, in the dock, the Scenes list and the scene timelines.
//   node --test test/build-progress.test.mjs
// Synthetic temporary studio only: no server, browser, agent, media processing, keys or network. The sheet.py test
// runs python3 when it is installed (skipped on Windows and where it isn't).
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync, readFileSync, utimesSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = mkdtempSync(join(realpathSync(tmpdir()), 'octopus-build-progress-'));
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

// ---------- B5b: Build's progress per scene ----------
test('B5b: a Build run counts scenes queued → building → built from the sheet’s marks, in its scope', async () => {
  const B = await import('../server/build-progress.mjs');
  const dir = planFixture('b5b-intro');
  const step = { id: 'intro', stage: 'Build', kind: 'claude', scenes: 'intro' };
  assert.equal(B.startBuildRun('x', dir, { id: 'plan', stage: 'Plan', kind: 'claude' }), null, 'only Build steps');
  B.startBuildRun('b5b-intro', dir, step, { now: Date.now() - 1000 });
  assert.equal(B.buildProgress('b5b-intro', dir), null, 'nothing marked yet: today’s behaviour');
  setStatus(dir, { 1: 'building' });
  let b = B.buildProgress('b5b-intro', dir);
  assert.deepEqual([b.total, b.built, b.current, b.order], [2, 0, { id: '1', n: 1, k: 1 }, ['1', '2']]);
  assert.deepEqual(b.states, { 1: 'building', 2: 'queued', 3: 'notin', 4: 'notin' }, 'the body is not in Build the intro');
  setStatus(dir, { 1: 'built', 2: 'building' });
  b = B.buildProgress('b5b-intro', dir);
  assert.deepEqual([b.built, b.current.k, b.current.id], [1, 2, '2']);
  setStatus(dir, { 2: 'built' });
  b = B.buildProgress('b5b-intro', dir);
  assert.deepEqual([b.built, b.current], [2, null]);
  B.endBuildRun('b5b-intro');
  assert.equal(B.buildProgress('b5b-intro', dir), null);
});
test('B5b: a second build starts from queued; a scene preview counts as built; no scope builds every scene', async () => {
  const B = await import('../server/build-progress.mjs');
  const dir = planFixture('b5b-again');
  setStatus(dir, { 1: 'built', 2: 'built', 3: 'built', 4: 'built' });
  const at = Date.now() - 2000;
  B.startBuildRun('b5b-again', dir, { id: 'build-visuals', stage: 'Build', kind: 'claude' }, { now: at });
  assert.equal(B.buildProgress('b5b-again', dir), null, 'built before the run: not counted until marked again');
  setStatus(dir, { 1: 'building' });
  B.noteBuildFiles('b5b-again', dir, ['work/production.json']);
  setStatus(dir, { 1: 'built' });
  let b = B.buildProgress('b5b-again', dir);
  assert.deepEqual([b.total, b.built, b.states['1'], b.states['2']], [4, 1, 'built', 'queued'], 'seen building in this run, then built');
  // A one-scene preview render made during the run.
  write(join(dir, 'renders', 'b5b-again_scene3_preview.mp4'), 'synthetic');
  b = B.buildProgress('b5b-again', dir);
  assert.deepEqual([b.built, b.states['3']], [2, 'built']);
  // An older preview (before the run) doesn't count.
  const old = join(dir, 'renders', 'b5b-again_scene4_preview.mp4'); write(old, 'synthetic'); utimesSync(old, new Date(at - 60000), new Date(at - 60000));
  assert.equal(B.buildProgress('b5b-again', dir).states['4'], 'queued');
  B.endBuildRun('b5b-again');
  // scopeOf: a block type nothing matches builds everything; a sheet section works too.
  const scenes = [{ id: 1, section: 'intro' }, { id: 2, section: 'body-1' }];
  assert.deepEqual(B.scopeOf(dir, scenes, 'intro'), ['1']);
  assert.deepEqual(B.scopeOf(dir, scenes, 'sponsor'), ['1', '2']);
  assert.deepEqual(B.scopeOf(dir, scenes, null), ['1', '2']);
});
test('B5b: the Scenes list, the dock and the scene timelines show it', async () => {
  const T = await import('../web/scene-tone.js');
  assert.equal(T.sceneTone({ run: 'building', approved: true, built: true }), 'building');
  assert.equal(T.sceneTone({ run: 'queued', notes: [{ status: 'open' }] }), 'queued', 'a running build wins over notes');
  assert.equal(T.sceneTone({ run: 'built' }), 'fresh');
  assert.equal(T.sceneTone({ run: 'notin', built: false }), 'notin');
  assert.equal(T.sceneTone({ run: 'notin', approved: true, built: true }), 'ok');
  assert.equal(T.sceneTone({ run: null, built: true }), 'none', 'no run: as before');
  assert.deepEqual(T.sceneRow({ tone: 'building', text: 'x' }), { quiet: true, picture: 'Building…', line: null, busy: true });
  assert.deepEqual(T.sceneRow({ tone: 'fresh', text: 'Built', built: true }), { quiet: false, picture: null, line: 'Built', busy: false });
  assert.equal(T.buildLegend({ marked: true, total: 10, built: 2, current: { k: 3 } }), 'Building · scene 3 of 10');
  assert.equal(T.buildLegend({ marked: true, total: 10, built: 10, current: null }), '10 of 10 built');
  assert.equal(T.buildLegend(null), '');
  const rail = src('web/rail.js'), idx = src('server/index.mjs'), app = src('web/app.js'), tl = src('web/timeline.js');
  assert.match(rail, /if \(b\.current\) return `scene \$\{b\.current\.k\} of \$\{b\.total\}`;/);
  assert.match(idx, /build: busy && stepRuns\.get\(id\) \? buildProgress\(id, dir\) : null,/);
  assert.match(idx, /startBuildRun\(id, dir, step\);/);
  assert.match(idx, /stepRuns\.delete\(id\); endBuildRun\(id\);/);
  assert.match(app, /tone: \{ built: 'fresh', building: 'building' \}\[getP\(\)\.build\?\.states\?\.\[String\(x\.id\)\]\] \|\| ''/);
  assert.match(tl, /fresh: col\.ok, building: col\.accent/);
});
test('B5b: the Build asks and the production-sheet skill (1.2.0+) mark each scene with one sheet.py command', () => {
  const pl = JSON.parse(src('core/pipelines.json'));
  const builds = Object.values(pl.formats).flatMap((f) => f.steps.filter((s) => typeof s === 'object' && s.stage === 'Build'));
  assert.ok(builds.length >= 4);
  for (const s of builds) assert.match(s.ask, /sheet\.py mark work\/production\.json building <scene id>/, s.id);
  assert.equal(builds.find((s) => s.id === 'intro').scenes, 'intro');
  const skills = JSON.parse(src('core/skills.json'));
  assert.equal(skills.skills.find((s) => s.id === 'octopus.production-sheet').version, '1.3.0'); // 1.3.0: cutouts (V1 step 6)
  const md = src('starter/.claude/skills/production-sheet/SKILL.md');
  assert.match(md, /sheet\.py mark work\/production\.json building 3/);
  assert.match(src('starter/.claude/skills/production-sheet/scripts/sheet.py'), /def cmd_mark\(a\):/);
});
const python = process.platform === 'win32' ? null : spawnSync('python3', ['--version']).status === 0 ? 'python3' : null;
test('B5b: sheet.py mark sets only the scenes’ status, all at once, and refuses an unknown id', { skip: !python && 'python3 is not installed' }, () => {
  const dir = planFixture('b5b-sheet'), sheet = join(dir, 'work/production.json');
  const script = fileURLToPath(new URL('../starter/.claude/skills/production-sheet/scripts/sheet.py', import.meta.url));
  const p0 = readJ(sheet); p0.approved = { at: 'x', by: 'creator' }; write(sheet, p0);
  const out = execFileSync(python, [script, 'mark', sheet, 'building', '1', '3']).toString();
  assert.match(out, /scenes 1, 3: building/);
  const p1 = readJ(sheet);
  assert.deepEqual(p1.scenes.map((s) => s.status), ['building', 'planned', 'building', 'planned']);
  assert.deepEqual(p1.approved, p0.approved, 'the rest of the sheet is kept');
  const bad = spawnSync(python, [script, 'mark', sheet, 'built', '9']);
  assert.notEqual(bad.status, 0);
  assert.deepEqual(readJ(sheet), p1, 'nothing changed');
  assert.notEqual(spawnSync(python, [script, 'mark', sheet, 'done', '1']).status, 0, 'only planned / building / built / approved');
});