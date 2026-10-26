// V1 "ultra simple", steps 1 and 2 (handoff v1-simple-2026-10-26/SPEC.md): the editor.mode setting (Simple by default,
// existing settings files included), the isAdvanced() gate, hidden pages landing on Projects, Simple's built-in style
// (one hidden profile, three formats, made once), the shape chip's rules (free until Build, confirm after; Audio only
// has none), and Simple → Advanced → Simple leaving the studio database byte for byte as it was.
// Pure modules in place; the server parts on a real server in a disposable app and studio copy, with a fake agent
// that never calls a model. Windows-safe: forward-slash paths, no special characters in file names, CRLF normalised.
//   node --test test/simple-mode.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawn, execFileSync } from 'node:child_process';
import { createServer } from 'node:net';
import { isAdvanced, editorMode, setEditorMode, onEditorMode } from '../web/mode.js';
import { legacyRoute, simpleRedirect } from '../web/nav.js';
import { SHAPES, SIMPLE_STEPS, simpleSteps, simpleProgress, simpleStageOf, shapeOfType, hiddenInSimple, HIDDEN_PAGES } from '../web/simple.js';
import { styleEntries } from '../web/style-list.js';
import { LearningStore, BUILTIN } from '../server/learning-store.mjs';

const APP = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const write = (path, value) => { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, value); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const lf = (s) => String(s).replace(/\r\n/g, '\n');
const PIPE = JSON.parse(lf(readFileSync(join(APP, 'core/pipelines.json'), 'utf8')));
const stepsOf = (type) => PIPE.formats[type].steps.map((s) => (typeof s === 'string' ? { id: s, ...PIPE.shared[s] } : s));

// ---------- the gate (web/mode.js) ----------
test('isAdvanced(): Simple until the mode is advanced; anything unknown is Simple', () => {
  assert.equal(editorMode(), 'simple');
  assert.equal(isAdvanced(), false);
  const heard = [];
  const off = onEditorMode((m) => heard.push(m));
  assert.equal(setEditorMode('advanced'), 'advanced');
  assert.equal(isAdvanced(), true);
  setEditorMode('advanced'); // no change: no second call
  assert.equal(setEditorMode('expert'), 'simple');
  assert.equal(isAdvanced(), false);
  setEditorMode(undefined);
  off();
  assert.deepEqual(heard, ['advanced', 'simple']);
});

// ---------- hidden pages (web/nav.js simpleRedirect, web/simple.js) ----------
test('Simple: every hidden page, also by an old address, lands on Projects; Advanced shows it', () => {
  const hidden = ['#/styles', '#/styles/instructions', '#/styles/memories', '#/styles/kits', '#/styles/kit/P/brand', '#/style/F/skill',
    '#/style/F/examples?panel=files', '#/recordings', '#/skills', '#/library', '#/scheduled', '#/channels', '#/channel/F'];
  for (const hash of hidden) {
    const moved = legacyRoute(hash) || hash; // the router rewrites an old address first
    assert.deepEqual(simpleRedirect(moved, 'simple')?.to, '#/', hash);
    assert.equal(simpleRedirect(moved, 'advanced'), null, hash);
  }
  // Old addresses that now open a hidden page: Memories, Learning, Brand, Instructions.
  for (const old of ['#/memories', '#/memories?scope=profile:P', '#/learning', '#/settings/brand', '#/settings/instructions']) {
    assert.ok(simpleRedirect(legacyRoute(old), 'simple'), old);
  }
  for (const shown of ['#/', '', '#/?new', '#/resources', '#/settings', '#/settings/general/editor', '#/p/my-video', '#/p/my-video?stage=cut', '#/setup']) {
    assert.equal(simpleRedirect(shown, 'simple'), null, shown);
  }
  assert.equal(simpleRedirect('#/styles', undefined)?.hidden, 'styles', 'no mode yet is Simple');
  assert.deepEqual(HIDDEN_PAGES.filter((p) => !hiddenInSimple({ page: p })), []);
});

// ---------- the Simple steps (web/simple.js) ----------
test('the built-in formats map onto Record · Rough cut · Scenes · Build · Thumbnail · Download; Audio only skips two', () => {
  assert.deepEqual(SIMPLE_STEPS.map((s) => s.label), ['Record', 'Rough cut', 'Scenes', 'Build', 'Thumbnail', 'Download']);
  const youtube = simpleSteps(stepsOf(SHAPES.youtube.type));
  assert.deepEqual(youtube.map((s) => [s.id, s.run.join(','), s.skipped]), [
    ['record', 'import', false], ['rough-cut', 'prepare,sections,lock', false], ['scenes', 'plan', false],
    ['build', 'intro', false], ['thumbnail', 'package', false], ['download', '', false]]);
  assert.deepEqual(youtube.find((s) => s.id === 'rough-cut').extra, ['cut-editor'], 'Fix the cut stays reachable, not a Simple step');
  const reel = simpleSteps(stepsOf(SHAPES.reel.type));
  assert.deepEqual(reel.find((s) => s.id === 'build').run, ['edit-short']);
  const audio = simpleSteps(stepsOf(SHAPES.audio.type));
  assert.deepEqual(audio.filter((s) => s.skipped).map((s) => s.id), ['scenes', 'build']);
  assert.deepEqual(audio.find((s) => s.id === 'thumbnail').run, ['package'], 'a podcast cover, optional');

  // Progress: Record done → Rough cut current; Audio only after its cut → Download (Thumbnail stays optional).
  const status = (type, done) => ({ steps: stepsOf(type).map((s) => ({ id: s.id, stage: s.stage, optional: Boolean(s.optional), done: done.includes(s.id) })) });
  let p = simpleProgress(status('tutorial', ['import']));
  assert.equal(p.current, 'rough-cut');
  assert.deepEqual(p.steps.map((s) => s.state), ['done', 'current', 'todo', 'todo', 'todo', 'todo']);
  p = simpleProgress(status('audio', ['import', 'prepare', 'sections', 'lock']));
  assert.equal(p.current, 'download');
  assert.deepEqual(p.steps.map((s) => s.state), ['done', 'done', 'skipped', 'skipped', 'todo', 'current']);
  assert.equal(simpleProgress(status('audio', ['import', 'prepare', 'sections', 'lock']), { exported: true }).current, null);

  assert.equal(shapeOfType('short'), 'reel');
  assert.equal(shapeOfType('reel'), 'reel');
  assert.equal(shapeOfType('faceless'), 'youtube');
  assert.equal(shapeOfType('audio'), 'audio');
  assert.equal(simpleStageOf({ type: 'tutorial', stage: 'Cut' }), 'Rough cut');
  assert.equal(simpleStageOf({ type: 'tutorial', stage: 'Plan' }), 'Scenes');
  assert.equal(simpleStageOf({ type: 'short', stage: 'Polish' }), 'Download');
  assert.equal(simpleStageOf({ type: 'tutorial', stage: null, progress: [1, 1], next: null }), 'done');
});

// ---------- the built-in style (server/learning-store.mjs) ----------
test('the built-in style: one hidden profile with three formats, made once, never listed as a style', (t) => {
  const studio = mkdtempSync(join(realpathSync(tmpdir()), 'octopus-builtin-'));
  t.after(() => rmSync(studio, { recursive: true, force: true }));
  const s = new LearningStore(studio);
  try {
    const mine = s.profile('Mine');
    const own = s.format(mine.id, 'My tutorial', 'tutorial');
    assert.equal(s.list('profiles').filter((p) => p.system === BUILTIN).length, 0, 'nothing is made before it is needed');
    const first = s.builtinFormats();
    assert.deepEqual(Object.keys(first), ['youtube', 'reel', 'audio']);
    assert.deepEqual(Object.values(first).map((f) => [f.name, f.type, f.builtin]), [
      ['YouTube video', 'tutorial', 'youtube'], ['Reel or Short', 'short', 'reel'], ['Audio only', 'audio', 'audio']]);
    const again = s.builtinFormats();
    assert.deepEqual(Object.values(again).map((f) => f.id), Object.values(first).map((f) => f.id), 'created once');
    const profiles = s.list('profiles').filter((p) => p.system === BUILTIN);
    assert.equal(profiles.length, 1);
    assert.equal(profiles[0].name, 'My brand');
    assert.equal(s.list('formats').length, 4);
    // It can't be renamed, archived or moved, like No brand, and it isn't No brand.
    assert.throws(() => s.updateFormat(first.youtube.id, { expected: 1, name: 'X' }), /built-in style/);
    assert.throws(() => s.archiveFormat(first.reel.id, 1), /built-in style/);
    assert.throws(() => s.updateProfile(profiles[0].id, { expected: 1, name: 'X' }), /cannot be renamed/);
    assert.equal(s.isBuiltin(profiles[0].id), true);
    assert.equal(s.isUnbranded(profiles[0].id), false);
    // My styles (Advanced) never lists the built-in formats; the editor's picker keeps the one its video uses.
    const data = { profiles: s.list('profiles'), formats: s.list('formats'), versions: [], projects: [] };
    assert.deepEqual(styleEntries(data).map((e) => e.name), ['My tutorial']);
    const kept = styleEntries(data, { keep: first.reel.id });
    assert.deepEqual(kept.map((e) => e.name).sort(), ['My tutorial', 'Reel or Short']);
    assert.equal(kept.find((e) => e.builtin).kitName, 'Built-in');
    assert.equal(own.profileId, mine.id);
  } finally { s.close(); }
});

// ---------- the setting's default (server/settings.mjs) ----------
test('editor.mode: Simple for a settings file without it (existing users), Advanced only when it says so', async (t) => {
  const local = mkdtempSync(join(realpathSync(tmpdir()), 'octopus-mode-'));
  const prior = process.env.STUDIO_LOCAL_DIR;
  process.env.STUDIO_LOCAL_DIR = local;
  t.after(() => { if (prior === undefined) delete process.env.STUDIO_LOCAL_DIR; else process.env.STUDIO_LOCAL_DIR = prior; rmSync(local, { recursive: true, force: true }); });
  const { section, editorMode: serverMode, isAdvanced: serverAdvanced, saveSection } = await import('../server/settings.mjs');
  const beta23 = { studio: '/x', appearance: { theme: 'dark' }, lastNewVideo: { profileId: 'p', formatId: 'f' } };
  assert.deepEqual(section('editor', beta23), { mode: 'simple' });
  assert.equal(serverMode({}), 'simple');
  assert.equal(serverMode({ editor: { mode: 'expert' } }), 'simple');
  assert.equal(serverMode({ editor: 'advanced' }), 'simple');
  assert.equal(serverAdvanced({ editor: { mode: 'advanced' } }), true);
  writeFileSync(join(local, 'settings.json'), JSON.stringify(beta23));
  assert.equal(serverMode(), 'simple');
  saveSection('editor', { mode: 'advanced' });
  assert.equal(serverMode(), 'advanced');
  assert.throws(() => saveSection('editor', { mode: 'pro' }), /Unknown choice/);
  const after = JSON.parse(readFileSync(join(local, 'settings.json'), 'utf8'));
  assert.deepEqual(after, { ...beta23, editor: { mode: 'advanced' } }, 'nothing else in the file changes');
});

// ---------- the server: New video ▾, the shape chip, the switch and the database ----------
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
async function startServer(t, extraSettings = {}) {
  const root = mkdtempSync(join(realpathSync(tmpdir()), 'octopus-simple-'));
  const app = join(root, 'app'), studio = join(root, 'studio'), home = join(root, 'home'), local = join(root, 'local'), bin = join(root, 'bin');
  for (const dir of [app, studio, home, local, bin]) mkdirSync(dir, { recursive: true });
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
  const shell = join(root, 'fixture-shell');
  write(shell, `#!${process.execPath}\nprocess.stdout.write('__P__' + process.env.PATH + '__P__');\n`);
  if (process.platform !== 'win32') execFileSync('chmod', ['700', shell]);
  const port = await freePort();
  write(join(local, 'settings.json'), JSON.stringify({
    studio, setup: { done: true, agent: '' }, updates: { auto: false }, scheduleCatchUp: false, permissionMode: 'auto', help: { stepsIntro: 'dismissed' },
    claude: { engine: 'claude', lean: true, ccSource: 'plan' }, claudePath: join(bin, 'claude.cmd'), ...extraSettings,
  }));
  write(join(local, 'schedules.json'), '{"v":1,"schedules":[]}');
  const env = {
    PATH: [bin, dirname(process.execPath), process.env.PATH].join(process.platform === 'win32' ? ';' : ':'),
    HOME: home, USERPROFILE: home, SHELL: shell, TMPDIR: root, TMP: root, TEMP: root, STUDIO_LOCAL_DIR: local, STUDIO_NO_OPEN: '1', STUDIO_NO_SCHEDULES: '1',
    CLAUDE_CONFIG_DIR: join(home, '.claude'), HF_HUB_OFFLINE: '1', PORT: String(port), LC_ALL: 'C',
    ...(process.platform === 'win32' ? { SystemRoot: process.env.SystemRoot, ComSpec: process.env.ComSpec } : {}),
  };
  execFileSync(process.execPath, ['--input-type=module', '-e', 'const {createStudio}=await import(process.argv[1]);createStudio(process.argv[2],{use:false});',
    new URL(`file://${join(app, 'server/starter.mjs').replaceAll('\\', '/').replace(/^(?=[A-Za-z]:)/, '/')}`).href, studio], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  const child = spawn(process.execPath, [join(app, 'server/index.mjs')], { cwd: app, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let logs = '';
  child.stdout.on('data', (b) => { logs += b; });
  child.stderr.on('data', (b) => { logs += b; });
  const url = `http://127.0.0.1:${port}`;
  t.after(async () => {
    if (child.exitCode === null) { child.kill(); for (let i = 0; i < 50 && child.exitCode === null && child.signalCode === null; i++) await sleep(100); }
    rmSync(root, { recursive: true, force: true, maxRetries: 5 });
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
  const meta = (id) => JSON.parse(lf(readFileSync(join(studio, 'projects', id, 'project.json'), 'utf8')));
  const settings = () => JSON.parse(lf(readFileSync(join(local, 'settings.json'), 'utf8')));
  return { root, studio, local, url, req, ok, meta, settings };
}

test('server: Simple is the default, New video ▾ uses the built-in style, the shape chip switches until Build and asks after', async (t) => {
  const s = await startServer(t, { lastNewVideo: { profileId: null, formatId: null } });
  // An existing user with a style of their own.
  const L = (path, data) => s.ok(`/api/learning${path}`, data);
  const A = await L('/profiles', { name: 'Tutorials' });
  const FA = await L('/formats', { profileId: A.id, name: 'Tutorial explainer', type: 'tutorial' });
  await s.ok('/api/projects', { untitled: true, formatId: FA.id }); // Advanced's New video: remembered as the last used

  const status = await s.ok('/api/status');
  assert.deepEqual(status.editor, { mode: 'simple', lastShape: 'youtube' }, 'no editor section in the file: Simple');
  assert.equal(status.formatInfo.audio.simple, true);
  assert.equal(status.formatInfo.tutorial.simple, false);

  // New video ▾ → YouTube video: the built-in style, not the creator's own, and Advanced's last-used is untouched.
  const yt = await s.ok('/api/projects', { untitled: true, shape: 'youtube' });
  let m = s.meta(yt.id);
  assert.equal(m.type, 'tutorial');
  assert.equal(m.name, 'Untitled video');
  assert.equal(m.context.formatName, 'YouTube video');
  assert.equal(m.context.profileName, 'My brand');
  assert.deepEqual(s.settings().lastNewVideo, { profileId: A.id, formatId: FA.id });
  assert.equal(s.settings().lastSimpleVideo, 'youtube');
  const reel = await s.ok('/api/projects', { untitled: true, shape: 'reel' });
  assert.equal(s.meta(reel.id).type, 'short');
  const audio = await s.ok('/api/projects', { untitled: true, shape: 'audio' });
  assert.equal(s.meta(audio.id).type, 'audio');
  assert.equal((await s.ok('/api/status')).editor.lastShape, 'audio', 'the last choice is preselected');
  assert.equal(s.meta(yt.id).context.profileId, s.meta(audio.id).context.profileId, 'one built-in profile');
  const bad = await s.req('/api/projects', { untitled: true, shape: 'square' });
  assert.equal(bad.status, 400);

  // The audio project has the Audio only steps (no Plan, no Build) and no shape chip.
  const ap = await s.ok(`/api/projects/${audio.id}`);
  assert.deepEqual(ap.pipeline.steps.map((x) => x.id), ['package', 'import', 'prepare', 'sections', 'cut-editor', 'lock']);
  const noChip = await s.req(`/api/project-context/${audio.id}/shape`, { shape: 'reel' });
  assert.equal(noChip.status, 400);
  assert.match(noChip.body.error, /Audio only/);

  // Before Build: switch freely, 16:9 → 9:16 → 16:9; the frame follows.
  let r = await s.ok(`/api/project-context/${yt.id}/shape`, { shape: 'reel' });
  assert.equal(r.typeChanged, true);
  m = s.meta(yt.id);
  assert.equal(m.type, 'short');
  assert.equal(m.layout.aspect, '9:16');
  assert.equal(m.context.formatName, 'Reel or Short');
  r = await s.ok(`/api/project-context/${yt.id}/shape`, { shape: 'youtube' });
  assert.equal(s.meta(yt.id).layout.aspect, '16:9');
  assert.equal((await s.ok(`/api/project-context/${yt.id}/shape`, { shape: 'youtube' })).unchanged, true);
  assert.deepEqual(s.settings().lastNewVideo, { profileId: A.id, formatId: FA.id }, 'the shape chip leaves Advanced alone');

  // After Build: asked first (409 needsConfirm), then switched with confirm, across video setups (unlike the style picker).
  write(join(s.studio, 'projects', yt.id, 'renders', `${yt.id}_intro_v1.mp4`), 'fixture render');
  const asked = await s.req(`/api/project-context/${yt.id}/shape`, { shape: 'reel' });
  assert.equal(asked.status, 409);
  assert.equal(asked.body.needsConfirm, true);
  assert.equal(s.meta(yt.id).type, 'tutorial', 'nothing changed before the OK');
  r = await s.ok(`/api/project-context/${yt.id}/shape`, { shape: 'reel', confirm: true });
  assert.equal(r.built, true);
  assert.equal(s.meta(yt.id).type, 'short');
  assert.match(lf(readFileSync(join(s.studio, 'projects', yt.id, 'WORKLOG.md'), 'utf8')), /Shape changed to Reel or Short after Build/);
  assert.ok(existsSync(join(s.studio, 'projects', yt.id, 'renders', `${yt.id}_intro_v1.mp4`)), 'the built video stays');
  // The style picker still refuses another video setup after Build (Advanced, unchanged).
  write(join(s.studio, 'projects', reel.id, 'renders', `${reel.id}_short_v1.mp4`), 'fixture render');
  const picker = await s.req(`/api/project-context/${reel.id}/select`, { formatId: FA.id, confirm: true });
  assert.equal(picker.status, 400);

  // The built-in formats are not the creator's styles: My styles' data marks them builtin, under the hidden profile.
  const profiles = await s.ok('/api/profiles');
  const builtins = profiles.formats.filter((f) => f.builtin);
  assert.deepEqual(builtins.map((f) => f.builtin), ['youtube', 'reel', 'audio']);
  assert.ok(profiles.profiles.find((p) => p.id === builtins[0].profileId).system);
});

test('server: Simple → Advanced → Simple changes only the setting; the database stays byte for byte', async (t) => {
  const s = await startServer(t);
  const L = (path, data) => s.ok(`/api/learning${path}`, data);
  const A = await L('/profiles', { name: 'Tutorials' });
  await L('/formats', { profileId: A.id, name: 'Tutorial explainer', type: 'tutorial' });
  await s.ok('/api/projects', { untitled: true, shape: 'youtube' });
  await s.ok('/api/projects', { untitled: true });
  // What every page reads, in both modes: the status, Projects, the counts, My styles, settings.
  const browse = async () => {
    for (const path of ['/api/status', '/api/projects', '/api/app/counts', '/api/learning', '/api/profiles', '/api/app/settings', '/api/takes']) await s.ok(path);
  };
  await browse();
  const dbFiles = () => ['studio.sqlite', 'studio.sqlite-wal', 'studio.sqlite-shm'].map((n) => join(s.studio, '.studio', n)).filter(existsSync);
  const snapshot = () => Object.fromEntries(dbFiles().map((f) => [f, readFileSync(f).toString('base64')]));
  const before = snapshot(), settingsBefore = s.settings();
  assert.ok(Object.keys(before).length, 'the studio has a database');

  await s.ok('/api/app/settings', { section: 'editor', values: { mode: 'advanced' } });
  assert.equal((await s.ok('/api/status')).editor.mode, 'advanced');
  await browse();
  await s.ok('/api/app/settings', { section: 'editor', values: { mode: 'simple' } });
  assert.equal((await s.ok('/api/status')).editor.mode, 'simple');
  await browse();

  assert.deepEqual(snapshot(), before, 'the studio database is unchanged');
  const { editor, ...rest } = s.settings();
  assert.deepEqual(editor, { mode: 'simple' });
  assert.deepEqual(rest, settingsBefore, 'only editor.mode was written to the settings');
});
