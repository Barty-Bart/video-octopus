// V1 step 6 (handoff v1-simple-2026-10-26/SPEC.md §7, Decision 6): rotoscoping inside Build. The plan flags the scenes
// that need a cutout (production sheet `cutout`, production-sheet 1.3.0); a Build cuts out only those, with the
// object-separation skill, when the selected Python can run SAM 2.1 and the model is downloaded; otherwise those scenes
// build with the plain layout and say "Built without the cutout · Set up". Nothing is ever downloaded here.
//   node --test test/roto.test.mjs
// Synthetic temporary studios and fake Pythons only: no model, no download, no network, no paid call. The server test
// runs a real server in a disposable app and studio copy with a fake agent. The sheet.py and fake-Python parts need
// python3 / a shebang and are skipped on Windows (like test/build-progress.test.mjs); the rest is Windows-safe.
import test from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync, chmodSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawn, spawnSync, execFileSync } from 'node:child_process';
import { createServer } from 'node:net';
import { needsCutout, subjectOf, subjectWords, cutoutOf, cuttingLine, fallbackNotes, buildCutouts, cutoutNotesHTML, SETUP_HREF, FALLBACK, whyText } from '../web/cutout.js';
import { sceneTone, sceneRow, buildLegend, TONE_LABEL } from '../web/scene-tone.js';
import { legacyRoute, simpleRedirect } from '../web/nav.js';

const APP = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const lf = (s) => String(s).replace(/\r\n/g, '\n');
const src = (rel) => lf(readFileSync(join(APP, rel), 'utf8'));
const write = (p, v) => { mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, typeof v === 'string' ? v : JSON.stringify(v, null, 2)); };
const readJ = (p) => JSON.parse(lf(readFileSync(p, 'utf8')));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const root = mkdtempSync(join(realpathSync(tmpdir()), 'octopus-roto-'));
const studio = join(root, 'studio'), local = join(root, 'local'), hf = join(root, 'hf');
write(join(local, 'settings.json'), { studio, projectsDir: 'projects' });
process.env.STUDIO_LOCAL_DIR = local;
process.env.HF_HOME = hf; // an empty Hugging Face cache: never the real one
delete process.env.HF_HUB_CACHE;
test.after(() => rmSync(root, { recursive: true, force: true, maxRetries: 5 }));

const SCENES = [
  { id: 1, block: 'intro', section: 'intro', start: 0, end: 2, layout: 'talking-head', line: 'Hello.', status: 'planned' },
  { id: 2, block: 'intro', section: 'intro', start: 2, end: 4, layout: 'cutout', visual: 'Title behind me', line: 'Big title.', status: 'planned' },
  { id: 3, block: 'intro', section: 'intro', start: 4, end: 6, layout: 'overlay', visual: 'The mug lifts off', cutout: true, cutout_subject: 'product', line: 'This mug.', status: 'planned' },
  { id: 4, block: 'main', section: 'body', start: 6, end: 8, layout: 'broll', visual: 'Me over B-roll', cutout: true, line: 'Body.', status: 'planned' },
  { id: 5, block: 'main', section: 'body', start: 8, end: 9, layout: 'screen', line: 'Bye.', status: 'planned' },
];
function project(id, scenes = SCENES) {
  const dir = join(studio, 'projects', id);
  write(join(dir, 'project.json'), { name: id, type: 'tutorial' });
  write(join(dir, 'work', 'blocks.json'), { v: 1, marked: true, blocks: [{ id: 'intro', type: 'intro', label: 'Intro', order: 1 }, { id: 'main', type: 'body', label: 'Main body', order: 2 }] });
  write(join(dir, 'work', 'production.json'), { scenes: structuredClone(scenes) });
  return dir;
}
const setScene = (dir, sid, patch) => { const f = join(dir, 'work/production.json'), p = readJ(f); Object.assign(p.scenes.find((s) => String(s.id) === String(sid)), patch); write(f, p); };
// A fake probePython (python-environments.mjs's shape): what the selected Python can import.
const ALL = { torch: true, torchvision: true, transformers: true, numpy: true, Pillow: true };
const probeOf = (r) => { const f = async (py, o) => { f.calls.push([py, o]); return r; }; f.calls = []; return f; };

// ---------- the rules (web/cutout.js) ----------
test('cutout flags: cutout: true or the cutout layout; the subject defaults to the speaker', () => {
  assert.equal(needsCutout(SCENES[0]), false);
  assert.equal(needsCutout(SCENES[1]), true, 'the cutout layout always needs one');
  assert.equal(needsCutout(SCENES[2]), true);
  assert.equal(needsCutout({ layout: 'broll', cutout: 'yes' }), false, 'only a real true');
  assert.equal(needsCutout({ shot: 'cutout' }), true, 'old sheets: shot');
  assert.equal(subjectOf(SCENES[1]), 'speaker');
  assert.equal(subjectOf(SCENES[2]), 'product');
  assert.equal(subjectWords('speaker'), 'you');
  assert.equal(subjectWords('product'), 'the product');
  assert.equal(subjectWords('the mug'), 'the mug');
  assert.equal(cuttingLine(3), 'Cutting you out for scene 3…');
  assert.equal(cuttingLine(4, 'product'), 'Cutting the product out for scene 4…');
});

test('a flagged scene’s cutout: cutting, done, skipped (by the builder, or by Video Octopus’s check), else planned', () => {
  assert.equal(cutoutOf(SCENES[0]), null);
  assert.deepEqual(cutoutOf(SCENES[1]), { subject: 'speaker', state: 'planned', why: null, text: '' });
  assert.equal(cutoutOf({ ...SCENES[1], status: 'cutting' }).state, 'cutting');
  assert.equal(cutoutOf({ ...SCENES[1], status: 'built', cutout_result: 'done' }).state, 'done');
  const sk = cutoutOf({ ...SCENES[1], status: 'built', cutout_result: 'skipped', cutout_why: 'no-model' });
  assert.deepEqual([sk.state, sk.why, sk.text], ['skipped', 'no-model', whyText('no-model')]);
  assert.match(sk.text, /isn’t downloaded/);
  // The Build started without object separation and the builder said nothing: still the fallback, once built.
  const doc = { ready: false, why: 'no-python', scenes: ['2'] };
  assert.equal(cutoutOf({ ...SCENES[1], status: 'building' }, doc).state, 'planned');
  assert.equal(cutoutOf({ ...SCENES[1], status: 'built' }, doc).state, 'skipped');
  assert.equal(cutoutOf({ ...SCENES[1], status: 'built' }, doc).why, 'no-python');
  assert.equal(cutoutOf({ ...SCENES[2], status: 'built' }, doc).state, 'planned', 'not a scene of that Build');
  assert.equal(cutoutOf({ ...SCENES[1], status: 'built' }, { ready: true, scenes: ['2'] }).state, 'planned');
});

test('the fallback note and its Set up link (Simple’s Build card, Scenes)', () => {
  assert.equal(SETUP_HREF, '#/setup/objsep');
  const summary = { scenes: [{ id: '2', n: 2, state: 'skipped', why: 'no-model', text: whyText('no-model') }, { id: '3', n: 3, state: 'done' }] };
  const notes = fallbackNotes(summary);
  assert.deepEqual(notes, [{ n: 2, text: 'Scene 2: Built without the cutout', why: whyText('no-model'), href: '#/setup/objsep', link: 'Set up' }]);
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  assert.match(cutoutNotesHTML(notes, esc), /Scene 2: Built without the cutout · <a href="#\/setup\/objsep">Set up<\/a>/);
  const card = buildCutouts({ build: { current: { id: '3', n: 3, k: 2, cutting: true, subject: 'speaker' } }, cutouts: summary });
  assert.equal(card.line, 'Cutting you out for scene 3…');
  assert.equal(card.notes.length, 1);
  assert.deepEqual(buildCutouts({}), { line: '', notes: [] });
  // Scenes: the tone while cutting, the row's fallback line, the list legend.
  assert.equal(sceneTone({ run: 'cutting' }), 'cutting');
  assert.equal(TONE_LABEL.cutting, 'Cutting out…');
  assert.deepEqual(sceneRow({ tone: 'cutting', text: '' }).busy, true);
  const row = sceneRow({ tone: 'none', text: 'To review', built: true, cutout: { state: 'skipped', text: 'why' } });
  assert.deepEqual(row.fallback, { text: FALLBACK, why: 'why' });
  assert.equal(sceneRow({ tone: 'none', text: 'To review', built: true, cutout: { state: 'done' } }).fallback, undefined);
  assert.equal(buildLegend({ marked: true, total: 4, built: 1, current: { n: 3, k: 2, cutting: true, subject: 'speaker' } }), 'Cutting you out for scene 3…');
  // The Set up address is left alone by the router's rewrites in both modes, and Settings opens Setup at it.
  assert.equal(legacyRoute('#/setup/objsep'), null);
  assert.equal(simpleRedirect('#/setup/objsep', 'simple'), null);
  assert.match(src('web/settings.js'), /if \(hash === '#\/setup\/objsep'\) return setupPage\(ctx, \{ back: backTo, assistantPanel, focus: 'objsep' \}\);/);
  assert.match(src('web/setup.js'), /focus === 'objsep' && rows\.has\('objsep'\)/);
  assert.match(src('web/setup.js'), /id === focus \? ' su-focus' : ''/);
  assert.match(src('web/scenes.js'), /<a href="\$\{SETUP_HREF\}">Set up<\/a>/);
  assert.match(src('web/rail.js'), /if \(b\.current\?\.cutting\) return cuttingLine\(b\.current\.n, b\.current\.subject\);/);
});

// ---------- the plan: the production-sheet skill (1.3.0) ----------
test('the plan asks flag cutouts; the production-sheet skill 1.3.0 documents and checks them', () => {
  const pl = JSON.parse(src('core/pipelines.json'));
  const steps = Object.values(pl.formats).flatMap((f) => f.steps.filter((s) => typeof s === 'object'));
  const plans = steps.filter((s) => s.stage === 'Plan' && s.skill === 'production-sheet'), builds = steps.filter((s) => s.stage === 'Build');
  assert.equal(plans.length, 4);
  for (const s of plans) assert.match(s.ask, /set "cutout": true and "cutout_subject"/, s.id);
  for (const s of builds) {
    assert.match(s.ask, /Scenes with "cutout": true get their subject cut out first, with the object-separation skill and only for that scene's time range/, s.id);
    assert.match(s.ask, /Never download a model or install anything during this step\./, s.id);
  }
  assert.equal(JSON.parse(src('core/skills.json')).skills.find((s) => s.id === 'octopus.production-sheet').version, '1.3.0');
  const md = src('starter/.claude/skills/production-sheet/SKILL.md');
  assert.match(md, /\| `cutout` \| `true` when the scene needs its subject cut out/);
  assert.match(md, /\| `cutout_subject` \|/);
  assert.match(md, /sheet\.py mark work\/production\.json cutting 3/);
  assert.match(md, /sheet\.py cutout work\/production\.json skipped 3 --why no-model/);
});

const python = process.platform === 'win32' ? null : spawnSync('python3', ['--version']).status === 0 ? 'python3' : null;
test('sheet.py: cutouts lists the flagged scenes; mark cutting; cutout done / skipped; check and status', { skip: !python && 'python3 is not installed (or Windows)' }, () => {
  const dir = project('sheet-py'), sheet = join(dir, 'work/production.json');
  const script = join(APP, 'starter/.claude/skills/production-sheet/scripts/sheet.py');
  const run = (...a) => spawnSync(python, ['-B', script, ...a], { encoding: 'utf8' });
  const list = JSON.parse(run('cutouts', sheet, '--json').stdout);
  assert.deepEqual(list.map((x) => [x.id, x.subject]), [[2, 'speaker'], [3, 'product'], [4, 'speaker']]);
  assert.match(run('mark', sheet, 'cutting', '2').stdout, /scene 2: cutting/);
  assert.equal(readJ(sheet).scenes[1].status, 'cutting');
  assert.notEqual(run('cutout', sheet, 'done', '2').status, 0, 'done needs --masks');
  assert.match(run('cutout', sheet, 'done', '2', '--masks', 'work/objsep/scene2-speaker').stdout, /scene 2: cutout done/);
  assert.match(run('cutout', sheet, 'skipped', '3', '--why', 'no-model').stdout, /cutout skipped \(no-model\)/);
  const p = readJ(sheet);
  assert.deepEqual([p.scenes[1].cutout_result, p.scenes[1].cutout_masks, p.scenes[2].cutout_result, p.scenes[2].cutout_why], ['done', 'work/objsep/scene2-speaker', 'skipped', 'no-model']);
  const before = readFileSync(sheet, 'utf8');
  assert.notEqual(run('cutout', sheet, 'done', '1', '--masks', 'x').status, 0, 'scene 1 has no cutout planned');
  assert.notEqual(run('cutout', sheet, 'skipped', '4', '--why', 'tired').status, 0, 'only the known reasons');
  assert.equal(readFileSync(sheet, 'utf8'), before, 'nothing changed');
  const check = run('check', sheet);
  assert.match(check.stdout, /3 with a cutout/);
  assert.match(check.stdout, /scene 2 .*needs a cutout but no 'cutout_subject'/);
  assert.match(run('status', sheet).stdout, /cutouts +done: 1, skipped: 1, to do: 1/);
  setScene(dir, 1, { cutout: 'yes' });
  assert.equal(run('check', sheet).status, 1, "'cutout' must be true or false");
});

// ---------- the server: which scenes, can it run, the brief's note, work/cutouts.json ----------
test('Build cuts out only the flagged scenes in its own scope; other steps and unflagged plans add nothing', async () => {
  const R = await import('../server/roto.mjs');
  const dir = project('scope');
  assert.deepEqual(R.cutoutScenes(dir, 'intro').map(({ s, n }) => [String(s.id), n]), [['2', 2], ['3', 3]], 'Build the intro: the intro’s flagged scenes');
  assert.deepEqual(R.cutoutScenes(dir).map(({ s }) => String(s.id)), ['2', '3', '4'], 'a whole-video Build: every flagged scene');
  const probe = probeOf({ imports: ALL, sam2: true });
  const plan = await R.prepareRoto(dir, { id: 'plan', stage: 'Plan', kind: 'claude' }, { probe });
  assert.deepEqual([plan.note, probe.calls.length], ['', 0], 'not a Build: no check, no note');
  const flat = project('flat', SCENES.map(({ cutout, cutout_subject, ...s }) => ({ ...s, layout: s.layout === 'cutout' ? 'overlay' : s.layout })));
  const none = await R.prepareRoto(flat, { id: 'intro', stage: 'Build', kind: 'claude', scenes: 'intro' }, { probe });
  assert.deepEqual([none.note, probe.calls.length, existsSync(join(flat, R.CUTOUTS))], ['', 0, false], 'no flagged scene: nothing checked, nothing written');
});

test('can it run here: no Python, no SAM 2 packages, no model, ready (the import check is kept five minutes)', async () => {
  const R = await import('../server/roto.mjs');
  R.clearRotoCache();
  assert.equal((await R.rotoReadiness({ python: '/nowhere/python', probe: probeOf({ error: 'Python could not complete the check.' }), have: [], choice: 'auto' })).why, 'no-python');
  const old = await R.rotoReadiness({ python: '/py/old', probe: probeOf({ imports: ALL, sam2: false }), have: ['tiny'], choice: 'auto' });
  assert.deepEqual([old.ready, old.why], [false, 'no-packages']);
  assert.equal((await R.rotoReadiness({ python: '/py/notorch', probe: probeOf({ imports: { ...ALL, torch: false }, sam2: false }), have: ['tiny'] })).missing[0], 'torch');
  const probe = probeOf({ imports: ALL, sam2: true });
  assert.equal((await R.rotoReadiness({ python: '/py/ok', probe, have: [], choice: 'auto' })).why, 'no-model');
  assert.equal((await R.rotoReadiness({ python: '/py/ok', probe, have: ['tiny'], choice: 'large' })).why, 'no-model', 'the picked size must be there');
  const ok = await R.rotoReadiness({ python: '/py/ok', probe, have: ['base-plus'], choice: 'auto' });
  assert.deepEqual([ok.ready, ok.model, ok.auto], [true, 'base-plus', true], 'auto: any downloaded model (the skill falls back to it)');
  assert.equal(probe.calls.length, 1, 'one import check for that Python in five minutes');
  assert.deepEqual(probe.calls[0][1], { verify: true }, 'the verify probe: imports only, never a model');
  await R.rotoReadiness({ python: '/py/ok', probe, have: ['tiny'], choice: 'auto', now: Date.now() + 6 * 60e3 });
  assert.equal(probe.calls.length, 2, 'checked again after five minutes');
});

test('ready: the brief cuts out the flagged scenes only, on their time range, marking cutting and recording the result', async () => {
  const R = await import('../server/roto.mjs');
  R.clearRotoCache();
  const dir = project('ready');
  const r = await R.prepareRoto(dir, { id: 'intro', stage: 'Build', kind: 'claude', scenes: 'intro' }, { python: '/studio/.venv/bin/python', probe: probeOf({ imports: ALL, sam2: true }), have: ['tiny'], choice: 'auto' });
  assert.equal(r.ready.ready, true);
  assert.match(r.note, /^\nCutouts: 2 scenes need the subject cut out of the background \(production sheet "cutout"\): scene 2, 2\.00–4\.00 s: speaker; scene 3, 4\.00–6\.00 s: product\./);
  assert.match(r.note, /sheet\.py mark work\/production\.json cutting <scene id>/);
  assert.match(r.note, /"\/studio\/\.venv\/bin\/python" \.\.\/\.\.\/\.claude\/skills\/object-separation\/scripts\/objsep\.py separate <video> --name <mask name> --start <scene start> --end <scene end>/);
  assert.match(r.note, /scene 2 → scene2-speaker, scene 3 → scene3-product/);
  assert.match(r.note, /sheet\.py cutout work\/production\.json done <scene id> --masks work\/objsep\/<mask name>/);
  assert.match(r.note, /skipped <scene id> --why failed/);
  assert.match(r.note, /Never download a model or install packages during Build/);
  assert.doesNotMatch(r.note, /scene 4|scene 1,|scene 5/, 'not the body’s flagged scene, not the unflagged ones');
  assert.deepEqual(readJ(join(dir, R.CUTOUTS)), { ...readJ(join(dir, R.CUTOUTS)), step: 'intro', ready: true, why: null, model: 'tiny', scenes: ['2', '3'] });
});

test('not ready: the flagged scenes build plain and are recorded skipped; the view shows the fallback with Set up', async () => {
  const R = await import('../server/roto.mjs');
  const S = await import('../server/scenes.mjs');
  R.clearRotoCache();
  const dir = project('fallback');
  const r = await R.prepareRoto(dir, { id: 'build-visuals', stage: 'Build', kind: 'claude' }, { python: '/py/ok2', probe: probeOf({ imports: ALL, sam2: true }), have: [], choice: 'auto' });
  assert.equal(r.ready.why, 'no-model');
  assert.match(r.note, /Object separation can't run on this computer yet \(The SAM 2\.1 model isn’t downloaded yet/);
  assert.match(r.note, /Don't install, download or ask about it now: build those scenes with the plain layout/);
  assert.match(r.note, /sheet\.py cutout work\/production\.json skipped <scene id> --why no-model` \(2, 3 and 4\)/);
  assert.doesNotMatch(r.note, /objsep\.py separate/, 'no separation when it can’t run');
  assert.deepEqual(readJ(join(dir, R.CUTOUTS)).scenes, ['2', '3', '4']);
  // The builder records scene 2 skipped, builds scene 3 and says nothing about it; scene 4 is still building.
  setScene(dir, 2, { status: 'built', cutout_result: 'skipped', cutout_why: 'no-model' });
  setScene(dir, 3, { status: 'built' });
  setScene(dir, 4, { status: 'building' });
  const sum = R.cutoutSummary(dir);
  assert.deepEqual(sum.scenes.map((c) => [c.id, c.n, c.state]), [['2', 2, 'skipped'], ['3', 3, 'skipped'], ['4', 4, 'planned']]);
  assert.equal(sum.ready, false);
  assert.deepEqual(fallbackNotes(sum).map((x) => [x.text, x.href]), [['Scene 2: Built without the cutout', '#/setup/objsep'], ['Scene 3: Built without the cutout', '#/setup/objsep']]);
  const view = S.readProduction(dir);
  assert.deepEqual(view.scenes.map((s) => s.cutout?.state ?? null), [null, 'skipped', 'skipped', 'planned', null]);
  assert.equal(R.cutoutSummary(project('nothing', [SCENES[0], SCENES[4]])), null, 'a sheet with no cutout: nothing in the view');
});

test('Build progress: a scene being cut out is the current one, "Cutting you out for scene 2…"', async () => {
  const B = await import('../server/build-progress.mjs');
  const dir = project('progress');
  B.startBuildRun('progress', dir, { id: 'intro', stage: 'Build', kind: 'claude', scenes: 'intro' }, { now: Date.now() - 1000 });
  setScene(dir, 1, { status: 'built' }); setScene(dir, 2, { status: 'cutting' });
  let b = B.buildProgress('progress', dir);
  assert.deepEqual(b.current, { id: '2', n: 2, k: 2, cutting: true, subject: 'speaker' });
  assert.equal(b.states['2'], 'cutting');
  assert.equal(buildCutouts({ build: b }).line, 'Cutting you out for scene 2…');
  setScene(dir, 2, { status: 'building' });
  b = B.buildProgress('progress', dir);
  assert.deepEqual(b.current, { id: '2', n: 2, k: 2 });
  B.endBuildRun('progress');
});

test('nothing downloads without consent: Build only reads the cache; the Download stays Setup’s, behind its button', async () => {
  const R = await import('../server/roto.mjs');
  const H = await import('../server/hfmodels.mjs');
  R.clearRotoCache();
  const realFetch = globalThis.fetch;
  const asked = [];
  globalThis.fetch = async (url) => { asked.push(String(url)); throw new Error('no network in this test'); };
  try {
    const dir = project('consent');
    const r = await R.prepareRoto(dir, { id: 'intro', stage: 'Build', kind: 'claude', scenes: 'intro' }, { python: '/py/ok3', probe: probeOf({ imports: ALL, sam2: true }), choice: 'auto' });
    assert.equal(r.ready.why, 'no-model', 'the empty test cache has no SAM 2.1');
  } finally { globalThis.fetch = realFetch; }
  assert.deepEqual(asked, [], 'no request to Hugging Face or anywhere');
  assert.equal(H.downloadState('sam2').state, 'idle', 'no download started');
  assert.equal(existsSync(join(hf, 'hub')) ? readdirSync(join(hf, 'hub')).length : 0, 0, 'nothing written to the Hugging Face cache');
  const code = src('server/roto.mjs');
  assert.doesNotMatch(code, /startDownload|startSam2Download|fetch\(|models download/, 'roto.mjs never starts a download');
  assert.match(src('server/index.mjs'), /text \+= \(await prepareRoto\(dir, step\)\)\.note;/);
});

// ---------- end to end: a real server, a disposable app and studio copy, a fake agent ----------
async function fakeClaude() {
  const { createInterface } = await import('node:readline');
  const argv = process.argv.slice(2);
  const out = (item) => process.stdout.write(JSON.stringify(item) + '\n');
  if (argv.includes('--version')) { console.log('9.9.9 fixture'); return; }
  if (argv[0] === 'auth') { console.log('{"loggedIn":true,"authMethod":"claude.ai","subscriptionType":"fixture"}'); return; }
  let initialized = false;
  for await (const line of createInterface({ input: process.stdin })) {
    let m; try { m = JSON.parse(line); } catch { continue; }
    if (m.type !== 'user') continue;
    if (!initialized) { initialized = true; out({ type: 'system', subtype: 'init', session_id: `fixture-${process.pid}`, model: 'fixture-model' }); }
    out({ type: 'assistant', message: { content: [{ type: 'text', text: 'Fixture reply.' }] } });
    out({ type: 'result', subtype: 'success', is_error: false, duration_ms: 1 });
  }
}
const freePort = () => new Promise((done, fail) => {
  const s = createServer();
  s.once('error', fail);
  s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => done(port)); });
});
async function startServer(t, extraSettings = {}, { hfModel = false } = {}) {
  const base = mkdtempSync(join(realpathSync(tmpdir()), 'octopus-roto-srv-'));
  const app = join(base, 'app'), studioDir = join(base, 'studio'), home = join(base, 'home'), localDir = join(base, 'local'), bin = join(base, 'bin'), hfHome = join(base, 'hf');
  for (const dir of [app, studioDir, home, localDir, bin, hfHome]) mkdirSync(dir, { recursive: true });
  for (const dir of ['server', 'core', 'starter', 'web', 'bin']) cpSync(join(APP, dir), join(app, dir), { recursive: true });
  cpSync(join(APP, 'package.json'), join(app, 'package.json'));
  write(join(app, 'server/keychain.mjs'), `export const KEY_STORE = 'synthetic test fixture';
export async function readKey() { return null; }
export async function hasKey() { return false; }
export async function saveKey() { throw new Error('Fixture does not save credentials'); }
export async function removeKey() { throw new Error('Fixture does not remove credentials'); }
`);
  write(join(bin, 'claude.cmd'), 'unused npm shim fixture');
  write(join(bin, 'node_modules/@anthropic-ai/claude-code/package.json'), JSON.stringify({ type: 'module', bin: 'fixture.mjs' }));
  write(join(bin, 'node_modules/@anthropic-ai/claude-code/fixture.mjs'), `(${fakeClaude.toString()})().catch((e) => { console.error(e.stack); process.exitCode = 1; });\n`);
  const shell = join(base, 'fixture-shell');
  write(shell, `#!${process.execPath}\nprocess.stdout.write('__P__' + process.env.PATH + '__P__');\n`);
  if (process.platform !== 'win32') execFileSync('chmod', ['700', shell]);
  if (hfModel) {
    // A SAM 2.1 tiny snapshot laid out as huggingface_hub does (tiny placeholder files): "downloaded" for sam2Have().
    const repo = join(hfHome, 'hub', 'models--facebook--sam2.1-hiera-tiny'), rev = 'a'.repeat(40);
    write(join(repo, 'refs', 'main'), rev);
    for (const f of ['config.json', 'preprocessor_config.json', 'processor_config.json', 'video_preprocessor_config.json', 'model.safetensors']) write(join(repo, 'snapshots', rev, f), '{}');
  }
  const port = await freePort();
  write(join(localDir, 'settings.json'), JSON.stringify({
    studio: studioDir, setup: { done: true, agent: '' }, updates: { auto: false }, scheduleCatchUp: false, permissionMode: 'auto', help: { stepsIntro: 'dismissed' },
    claude: { engine: 'claude', lean: true, ccSource: 'plan' }, claudePath: join(bin, 'claude.cmd'), ...extraSettings,
  }));
  write(join(localDir, 'schedules.json'), '{"v":1,"schedules":[]}');
  const env = {
    PATH: [bin, dirname(process.execPath), process.env.PATH].join(process.platform === 'win32' ? ';' : ':'),
    HOME: home, USERPROFILE: home, SHELL: shell, TMPDIR: base, TMP: base, TEMP: base, STUDIO_LOCAL_DIR: localDir, STUDIO_NO_OPEN: '1', STUDIO_NO_SCHEDULES: '1',
    CLAUDE_CONFIG_DIR: join(home, '.claude'), HF_HOME: hfHome, HF_HUB_OFFLINE: '1', HF_ENDPOINT: 'http://127.0.0.1:9', PORT: String(port), LC_ALL: 'C',
    ...(process.platform === 'win32' ? { SystemRoot: process.env.SystemRoot, ComSpec: process.env.ComSpec } : {}),
  };
  execFileSync(process.execPath, ['--input-type=module', '-e', 'const {createStudio}=await import(process.argv[1]);createStudio(process.argv[2],{use:false});',
    new URL(`file://${join(app, 'server/starter.mjs').replaceAll('\\', '/').replace(/^(?=[A-Za-z]:)/, '/')}`).href, studioDir], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  const child = spawn(process.execPath, [join(app, 'server/index.mjs')], { cwd: app, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let logs = '';
  child.stdout.on('data', (b) => { logs += b; });
  child.stderr.on('data', (b) => { logs += b; });
  const url = `http://127.0.0.1:${port}`;
  t.after(async () => {
    if (child.exitCode === null) { child.kill(); for (let i = 0; i < 50 && child.exitCode === null && child.signalCode === null; i++) await sleep(100); }
    rmSync(base, { recursive: true, force: true, maxRetries: 5 });
  });
  const req = async (path, data) => {
    const r = await fetch(url + path, data === undefined ? {} : { method: 'POST', headers: { 'X-Studio': '1', 'Content-Type': 'application/json' }, body: JSON.stringify(data) });
    const text = await r.text();
    let body; try { body = JSON.parse(text); } catch { body = text; }
    return { status: r.status, body };
  };
  const ok = async (path, data) => { const r = await req(path, data); assert.equal(r.status, 200, `${path}: ${JSON.stringify(r.body)}\n${logs.slice(-1500)}`); return r.body; };
  for (let i = 0; i < 200; i++) {
    if (child.exitCode !== null) throw new Error(logs);
    try { if ((await fetch(`${url}/api/learning`)).ok) break; } catch {}
    await sleep(100);
  }
  const fixture = (id) => {
    const dir = join(studioDir, 'projects', id);
    write(join(dir, 'project.json'), JSON.stringify({ name: id, type: 'tutorial' }));
    write(join(dir, 'WORKLOG.md'), '- Cut locked (join-check: 0 joins, 0 clipped)\n');
    write(join(dir, 'work', 'blocks.json'), JSON.stringify({ v: 1, marked: true, blocks: [{ id: 'intro', type: 'intro', label: 'Intro', order: 1 }, { id: 'main', type: 'body', label: 'Main body', order: 2 }] }));
    write(join(dir, 'work', 'production.json'), JSON.stringify({ scenes: SCENES, approved: { at: new Date().toISOString(), by: 'creator' } }));
    return dir;
  };
  return { base, studio: studioDir, url, req, ok, fixture, hfHome, logs: () => logs };
}
const hubList = (hfHome) => (existsSync(join(hfHome, 'hub')) ? readdirSync(join(hfHome, 'hub')).sort() : []);

test('server: Build the intro with no Python that can run SAM 2.1 → the plain-layout note, cutouts.json, the fallback in the view', async (t) => {
  const s = await startServer(t, { python: join(tmpdir(), 'octopus-no-such-python', 'python'), editor: { mode: 'advanced' } }); // Advanced: Build is the intro
  const dir = s.fixture('nopython');
  const before = hubList(s.hfHome);
  const r = await s.ok('/api/projects/nopython/step', { step: 'intro' });
  assert.match(r.text, /Cutouts: 2 scenes need the subject cut out/);
  assert.match(r.text, /No Python that can run object separation is selected/);
  assert.match(r.text, /--why no-python` \(2 and 3\)/);
  assert.doesNotMatch(r.text, /objsep\.py separate/);
  assert.deepEqual(readJ(join(dir, 'work/cutouts.json')).scenes, ['2', '3']);
  // The builder records scene 2 as built without the cutout: the project view and Scenes carry the note.
  const f = join(dir, 'work/production.json'), p = readJ(f);
  Object.assign(p.scenes[1], { status: 'built', cutout_result: 'skipped', cutout_why: 'no-python' });
  write(f, JSON.stringify(p));
  const view = await s.ok('/api/projects/nopython');
  assert.deepEqual(view.cutouts.scenes.map((c) => [c.id, c.state]), [['2', 'skipped'], ['3', 'planned'], ['4', 'planned']]);
  assert.deepEqual(fallbackNotes(view.cutouts).map((x) => x.href), ['#/setup/objsep']);
  assert.deepEqual(hubList(s.hfHome), before, 'nothing downloaded');
});

test('server: Build the intro with a Python that runs SAM 2.1 and a downloaded model → the separate-then-build note', { skip: process.platform === 'win32' && 'the fake Python is a shebang script' }, async (t) => {
  const fakePy = join(mkdtempSync(join(realpathSync(tmpdir()), 'octopus-fake-py-')), 'python');
  write(fakePy, `#!${process.execPath}\nprocess.stdout.write(JSON.stringify({ imports: { torch: true, torchvision: true, transformers: true, numpy: true, Pillow: true }, sam2: true, errors: {} }) + '\\n');\n`);
  chmodSync(fakePy, 0o755);
  t.after(() => rmSync(dirname(fakePy), { recursive: true, force: true }));
  const s = await startServer(t, { python: fakePy, editor: { mode: 'advanced' } }, { hfModel: true }); // Advanced: Build is the intro
  const dir = s.fixture('ready');
  const before = hubList(s.hfHome);
  const r = await s.ok('/api/projects/ready/step', { step: 'intro' });
  assert.match(r.text, /Object separation is ready here/);
  assert.match(r.text, /SAM 2\.1 tiny/);
  assert.match(r.text, /objsep\.py separate <video> --name <mask name> --start <scene start> --end <scene end>/);
  assert.match(r.text, /scene 2 → scene2-speaker, scene 3 → scene3-product/);
  assert.doesNotMatch(r.text, /scene 4 →/);
  assert.equal(readJ(join(dir, 'work/cutouts.json')).ready, true);
  // While the builder cuts scene 2 out, the dock's progress says so.
  const f = join(dir, 'work/production.json'), p = readJ(f);
  p.scenes[1].status = 'cutting';
  write(f, JSON.stringify(p));
  let view = null;
  for (let i = 0; i < 40; i++) { view = await s.ok('/api/projects/ready'); if (view.build?.current || !view.busy) break; await sleep(50); }
  if (view.busy) assert.equal(buildCutouts(view).line, 'Cutting you out for scene 2…');
  assert.equal(view.cutouts.scenes[0].state, 'cutting');
  assert.deepEqual(hubList(s.hfHome), before, 'nothing downloaded');
});
