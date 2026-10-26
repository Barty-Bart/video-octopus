// V1 "ultra simple", the glue between the parts built apart (handoff v1-build-2026-10-26/final): roto progress and its
// fallback in Simple's Build card (web/cutout.js buildCutouts in web/simple-flow.js stepCard), Drop for Claude's "Also
// add to Resources" (server/simple-resources.mjs addFromProject: one copy in the file store), ⌥⌘R starting a take in
// Simple (web/simple-editor.js) and the Music tool's beds that ffmpeg synthesises (server/simple-music.mjs). Real
// server parts run in a disposable app and studio copy with a fake agent that never calls a model or the network.
// Windows-safe: forward-slash paths, plain file names, CRLF normalised.
//   node --test test/v1-glue.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { tmpdir, homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawn, execFileSync } from 'node:child_process';
import { createServer } from 'node:net';
import { png } from './png-fixture.mjs';
import { stepCard, cleanTools, MUSIC_BEDS } from '../web/simple-flow.js';
import { dropKind } from '../web/resource-kinds.js';
import { BED_TONES, bedArgs, bedFile, bedSeconds } from '../server/simple-music.mjs';

const APP = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const write = (path, value) => { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, value); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const lf = (s) => String(s).replace(/\r\n/g, '\n');
const src = (f) => lf(readFileSync(join(APP, f), 'utf8'));
const PIPE = JSON.parse(src('core/pipelines.json'));
const stepsOf = (type, done = []) => PIPE.formats[type].steps.map((s) => (typeof s === 'string' ? { id: s, ...PIPE.shared[s] } : s))
  .map((s) => ({ id: s.id, name: s.name || s.label || s.id, stage: s.stage || (s.id === 'plan' ? 'Plan' : ['intro', 'edit-short'].includes(s.id) ? 'Build' : null), optional: Boolean(s.optional), done: done.includes(s.id), skipped: false }));
const view = (type, { done = [], busy = false, running = null, extra = {} } = {}) => ({
  type, name: 'My video', busy, running, canvas: { cam: 'take_webcam.mp4' }, export: { duration: 71, cut: null },
  pipeline: { steps: stepsOf(type, ['import', ...done]) }, renders: [], textExports: [], prepare: { needs: 0, summary: '' }, ...extra,
});
const CUT = ['prepare', 'sections', 'lock', 'plan'];
const skipped2 = { ready: false, why: 'no-model', scenes: [{ id: '2', n: 2, subject: 'speaker', state: 'skipped', why: 'no-model', text: 'The SAM 2.1 model isn’t downloaded yet.' }] };

// ---------- Build card: roto progress and the fallback ----------
test('Build card: "Cutting you out for scene 2…" while it runs, then "Built without the cutout · Set up" (#/setup/objsep)', () => {
  const cutting = view('tutorial', { done: CUT, busy: true, running: 'intro', extra: { build: { total: 4, built: 1, current: { id: '2', n: 2, k: 2, cutting: true, subject: 'speaker' } } } });
  let c = stepCard(cutting);
  assert.equal(c.step, 'build');
  assert.equal(c.lines[0], 'Cutting you out for scene 2…');
  assert.deepEqual(c.notes, []);
  const product = view('tutorial', { done: CUT, busy: true, running: 'intro', extra: { build: { total: 4, built: 2, current: { id: '3', n: 3, k: 3, cutting: true, subject: 'product' } } } });
  assert.equal(stepCard(product).lines[0], 'Cutting the product out for scene 3…');
  // a scene built without its cutout while the rest still build
  const later = view('tutorial', { done: CUT, busy: true, running: 'intro', extra: { build: { total: 4, built: 2, current: { id: '3', n: 3, k: 3 } }, cutouts: skipped2 } });
  c = stepCard(later);
  assert.equal(c.lines[0], 'Scene 3 of 4');
  assert.deepEqual(c.notes.map((x) => [x.text, x.link, x.href]), [['Scene 2: Built without the cutout', 'Set up', '#/setup/objsep']]);
  // after Build: the note stays with Thumbnail and Download
  const built = view('tutorial', { done: [...CUT, 'intro'], extra: { cutouts: skipped2 } });
  assert.equal(stepCard(built).step, 'thumbnail');
  assert.equal(stepCard(built).notes.length, 1);
  assert.equal(stepCard(built, { pastThumb: true }).notes.length, 1);
  // nothing flagged: no notes; Audio only never has them
  assert.deepEqual(stepCard(view('tutorial', { done: [...CUT, 'intro'] })).notes, []);
  assert.equal(stepCard(view('audio', { done: ['prepare', 'sections', 'lock'], extra: { cutouts: skipped2 } })).notes, undefined);
  // the card draws them with cutout.js's HTML, and Setup stays open in Simple (not a hidden page)
  const ed = src('web/simple-editor.js');
  assert.match(ed, /cutoutNotesHTML\(c\.notes, esc\)/);
  assert.match(src('web/simple.css'), /\.sx-notes \.cut-fb/);
});

test('Setup (Set up) is reachable in Simple: not a hidden page, and linked from Settings', async () => {
  const { hiddenInSimple } = await import('../web/simple.js');
  const { parseRoute } = await import('../web/nav.js').catch(() => ({}));
  if (parseRoute) assert.equal(hiddenInSimple(parseRoute('#/setup/objsep'), 'simple'), false);
  assert.equal(hiddenInSimple({ page: 'setup' }, 'simple'), false);
  assert.match(src('web/settings.js'), /#\/setup\/objsep/);
  assert.match(src('web/settings.js'), /href="#\/setup">Run setup again/);
});

// ---------- ⌥⌘R starts a take in Simple ----------
test('⌥⌘R in Simple starts a take on the Record step (and only there); stopping stays app.js\'s', () => {
  const ed = src('web/simple-editor.js');
  const key = ed.slice(ed.indexOf('const onRecKey'), ed.indexOf("document.addEventListener('keydown', onRecKey)"));
  assert.match(key, /rec\.isHotkey\(e\)/);
  assert.match(key, /S\.phase !== 'idle'/, 'while recording, app.js stops the take');
  assert.match(key, /card\(\)\.step !== 'record'/, 'later steps never replace the take from the keyboard');
  assert.match(key, /record\(sourcesFor\(id, getP\(\)\), recPage\.text\(\)\)/, 'the same start as the Record button');
  assert.match(ed, /removeEventListener\('keydown', onRecKey\)/);
  assert.match(src('web/app.js'), /if \(S\.phase === 'recording'\) rec\.stop\(\);/);
});

// ---------- found in the walkthrough ----------
test('Record again: while the new take saves, the card waits instead of offering Keep on the old take', () => {
  const c = stepCard(view('tutorial'), { recording: true, saving: true });
  assert.equal(c.step, 'record');
  assert.equal(c.title, 'Saving your take…');
  assert.deepEqual(c.buttons, []);
  assert.equal(stepCard(view('tutorial')).buttons[0].a, 'keep');
  assert.match(src('web/simple-editor.js'), /const saving = \['stopping', 'saving'\]\.includes\(S\.phase\) && mine;/);
});

test('Download gives the chosen thumbnail next to the video; the progress line folds to dots below 1280 px', () => {
  const ed = src('web/simple-editor.js');
  assert.match(ed, /\/api\/packaging\/\$\{encodeURIComponent\(id\)\}\/item\/\$\{encodeURIComponent\(st\.mainThumb\.id\)\}/);
  assert.match(ed, /Download the thumbnail/);
  assert.match(ed, /x\.id === v\.board\?\.main/);
  assert.match(src('web/simple.css'), /@media \(max-width: 1279px\) \{\n  \.sx-prog \.sx-st:not\(\.current\) \{ font-size: 0; gap: 0; \}/);
  // the dock's two-line cutting row uses its own class (style.css has a generic .two grid)
  assert.match(src('web/rail.js'), /dk-two/);
  assert.match(src('web/style.css'), /\.dk-name\.dk-two \.dk-sub \{ display: block; \}/);
});

// ---------- Drop for Claude → Also add to Resources ----------
test('dropKind: the kind a dropped file joins Resources as', () => {
  assert.equal(dropKind('source/app shot.png'), 'product');
  assert.equal(dropKind('acme-logo.png'), 'logo');
  assert.equal(dropKind('mark.svg'), 'logo');
  assert.equal(dropKind('Brand.woff2'), 'font');
  assert.equal(dropKind('b-roll.MOV'), 'clip');
  for (const f of ['notes.pdf', 'voice.wav', 'script.md']) assert.equal(dropKind(f), null, f);
});

// ---------- Music beds ----------
test('Music beds: three synthesised beds, made once per length; the tool keeps which bed', () => {
  assert.deepEqual(Object.keys(MUSIC_BEDS), Object.keys(BED_TONES));
  assert.equal(bedSeconds(3), 10);
  assert.equal(bedSeconds(99999), 3600);
  assert.equal(bedFile('calm', 71.2), 'work/music/calm-71s.m4a');
  for (const k of Object.keys(BED_TONES)) {
    const a = bedArgs(k, 30, 'out.m4a');
    const expr = a[a.indexOf('-i') + 1];
    assert.match(expr, /^aevalsrc=/);
    assert.doesNotMatch(expr.replace(/\\,/g, ''), /,/, `${k}: commas escaped for the filtergraph`);
    assert.ok(!a.some((x) => /^https?:/.test(x)), 'nothing downloaded');
  }
  assert.equal(cleanTools({ music: { cue: 'c1', file: 'work/music/calm-71s.m4a', bed: 'calm', gain: -12 } }).music.bed, 'calm');
  assert.equal(cleanTools({ music: { cue: 'c1', file: 'x.wav', bed: 'disco' } }).music.bed, undefined);
});

// ---------- a real server ----------
// The fake Claude Code: logs each launch (its working folder and system prompt) and message to OCTOPUS_TEST_LOG; a brand
// research session writes its proposal like the real one would (no browsing: a synthetic page).
async function fakeClaude() {
  const { appendFileSync, existsSync, readFileSync, mkdirSync, writeFileSync } = await import('node:fs');
  const { join } = await import('node:path');
  const { createInterface } = await import('node:readline');
  const argv = process.argv.slice(2);
  const arg = (key) => (argv.includes(key) ? argv[argv.indexOf(key) + 1] : null);
  const out = (item) => process.stdout.write(JSON.stringify(item) + '\n');
  const log = (item) => appendFileSync(process.env.OCTOPUS_TEST_LOG, JSON.stringify({ pid: process.pid, ...item }) + '\n');
  if (argv.includes('--version')) { console.log('9.9.9 fixture'); return; }
  if (argv[0] === 'auth') { console.log('{"loggedIn":true,"authMethod":"claude.ai","subscriptionType":"fixture"}'); return; }
  const file = arg('--append-system-prompt-file');
  const prompt = file && existsSync(file) ? readFileSync(file, 'utf8') : arg('--append-system-prompt') || '';
  log({ kind: 'launch', cwd: process.cwd(), prompt });
  let initialized = false;
  for await (const line of createInterface({ input: process.stdin })) {
    let m; try { m = JSON.parse(line); } catch { continue; }
    if (m.type !== 'user') continue;
    const text = typeof m.message?.content === 'string' ? m.message.content : JSON.stringify(m.message?.content);
    log({ kind: 'message', text });
    if (!initialized) { initialized = true; out({ type: 'system', subtype: 'init', session_id: `fixture-${process.pid}`, model: 'fixture-model' }); }
    if (prompt.includes('brand onboarding research')) {
      mkdirSync(join(process.cwd(), 'work'), { recursive: true });
      writeFileSync(join(process.cwd(), 'work', 'brand-proposal.json'), JSON.stringify({
        identity: 'Practical tutorials for solo creators.', audience: 'Solo creators', voice: 'Plain, friendly, a bit dry',
        colors: ['#0f766e', '#f59e0b'], fonts: 'Inter for text', notes: 'Synthetic fixture.',
        sources: [{ url: 'https://example.com/', note: 'Synthetic fixture page: no network.' }], assets: [],
      }));
    }
    out({ type: 'assistant', message: { content: [{ type: 'text', text: 'Fixture reply.' }] } });
    out({ type: 'result', subtype: 'success', is_error: false, duration_ms: 1 });
  }
}
const freePort = () => new Promise((done, fail) => {
  const s = createServer();
  s.once('error', fail);
  s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => done(port)); });
});
async function startServer(t, extra = {}) {
  const root = mkdtempSync(join(realpathSync(tmpdir()), 'octopus-v1glue-'));
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
  const port = await freePort(), logFile = join(root, 'agent.jsonl');
  write(join(local, 'settings.json'), JSON.stringify({
    studio, setup: { done: true, agent: '' }, updates: { auto: false }, scheduleCatchUp: false, permissionMode: 'auto', help: { stepsIntro: 'dismissed' },
    claude: { engine: 'claude', lean: true, ccSource: 'plan' }, claudePath: join(bin, 'claude.cmd'), ...extra,
  }));
  write(join(local, 'schedules.json'), '{"v":1,"schedules":[]}');
  write(logFile, '');
  const env = {
    PATH: [bin, dirname(process.execPath), process.env.PATH].join(process.platform === 'win32' ? ';' : ':'),
    HOME: home, USERPROFILE: home, SHELL: shell, TMPDIR: root, TMP: root, TEMP: root, STUDIO_LOCAL_DIR: local, STUDIO_NO_OPEN: '1', STUDIO_NO_SCHEDULES: '1',
    CLAUDE_CONFIG_DIR: join(home, '.claude'), HF_HUB_OFFLINE: '1', PORT: String(port), LC_ALL: 'C', OCTOPUS_TEST_LOG: logFile,
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
  const req = async (path, data, raw = null) => {
    const opts = raw ? { method: 'POST', headers: { 'X-Studio': '1' }, body: raw }
      : data === undefined ? {} : { method: 'POST', headers: { 'X-Studio': '1', 'Content-Type': 'application/json' }, body: JSON.stringify(data) };
    const r = await fetch(url + path, opts);
    const text = await r.text();
    let body; try { body = JSON.parse(text); } catch { body = text; }
    return { status: r.status, body, headers: r.headers };
  };
  const ok = async (path, data, raw) => { const r = await req(path, data, raw); assert.equal(r.status, 200, `${path}: ${JSON.stringify(r.body)}\n${logs.slice(-1500)}`); return r.body; };
  for (let i = 0; i < 200; i++) {
    if (child.exitCode !== null) throw new Error(logs);
    try { if ((await fetch(`${url}/api/learning`)).ok) break; } catch {}
    await sleep(100);
  }
  const project = (id) => join(studio, 'projects', id);
  const meta = (id) => JSON.parse(lf(readFileSync(join(project(id), 'project.json'), 'utf8')));
  const agentLog = () => lf(readFileSync(logFile, 'utf8')).split('\n').filter(Boolean).map((l) => JSON.parse(l));
  const upload = (name, kind, bytes) => req(`/api/simple-resources/upload?${new URLSearchParams({ name, kind })}`, undefined, bytes);
  const until = async (fn, what, ms = 15000) => { for (let i = 0; i < ms / 100; i++) { const v = await fn(); if (v) return v; await sleep(100); } throw new Error(`Timed out: ${what}\n${logs.slice(-1500)}`); };
  return { root, studio, url, req, ok, project, meta, agentLog, upload, until };
}

const PNG = png(4, 3, (x, y) => [x * 60, y * 80, 120]);
const findFfmpeg = () => { for (const f of [process.env.TEST_FFMPEG, 'ffmpeg', join(homedir(), '.local/bin/ffmpeg'), '/opt/homebrew/bin/ffmpeg', '/usr/local/bin/ffmpeg'].filter(Boolean)) { try { execFileSync(f, ['-version'], { stdio: 'pipe' }); return f; } catch {} } return null; };
const storeFiles = (studio) => { const out = []; const walk = (d) => { if (!existsSync(d)) return; for (const e of readdirSync(d, { withFileTypes: true })) { if (e.isDirectory()) walk(join(d, e.name)); else if (!e.name.startsWith('.')) out.push(join(d, e.name)); } }; walk(join(studio, '.studio', 'files')); return out; };

test('server: Also add to Resources stores a dropped file once; Music makes a bed and places it as a cue', async (t) => {
  const ffmpeg = findFfmpeg();
  const s = await startServer(t, ffmpeg ? { ffmpeg } : {});
  const v = await s.ok('/api/projects', { untitled: true, shape: 'youtube' });
  const drop = (name, bytes) => s.req(`/api/projects/${v.id}/drop?name=${encodeURIComponent(name)}`, undefined, bytes);
  const add = (q) => s.req(`/api/simple-resources/upload?${new URLSearchParams({ project: v.id, ...q })}`, {});
  const shot = (await drop('app shot.png', PNG)).body.file;
  assert.equal(shot, 'source/app shot.png');
  const before = storeFiles(s.studio).length;
  const r = await add({ file: shot, kind: dropKind(shot) });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual([r.body.kind, r.body.name, r.body.already], ['product', 'app shot.png', undefined]);
  assert.equal(storeFiles(s.studio).length, before + 1, 'one copy in the file store');
  assert.ok(existsSync(join(s.project(v.id), shot)), 'the project keeps its own file');
  // again, and the same bytes dropped under another name: the same tile, no new copy
  assert.equal((await add({ file: shot, kind: 'product' })).body.already, true);
  const again = (await drop('copy.png', PNG)).body.file;
  const r2 = await add({ file: again, kind: 'product' });
  assert.deepEqual([r2.body.already, r2.body.id], [true, r.body.id]);
  assert.equal(storeFiles(s.studio).length, before + 1);
  const files = (await s.ok('/api/simple-resources')).files;
  assert.deepEqual(files.map((f) => f.name), ['app shot.png']);
  // a kind left out comes from the name; refusals
  const logo = (await drop('acme-logo.svg', Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 4 4"><rect width="4" height="4"/></svg>'))).body.file;
  assert.equal((await add({ file: logo })).body.kind, 'logo');
  const pdf = (await drop('notes.pdf', Buffer.from('%PDF-1.4 fixture'))).body.file;
  assert.match((await add({ file: pdf })).body.error, /Resources keeps/);
  for (const bad of ['project.json', 'source/../project.json', '../other/source/x.png', 'source/missing.png']) assert.notEqual((await add({ file: bad, kind: 'product' })).status, 200, bad);
  assert.equal((await s.req(`/api/simple-resources/upload?${new URLSearchParams({ project: 'nope', file: shot })}`, {})).status, 404);
  assert.match(lf(readFileSync(join(s.project(v.id), 'WORKLOG.md'), 'utf8')), /Added app shot\.png to Resources \(product\)/);
  // the brief of a video on the built-in profile lists it (RESOURCES.md)
  assert.match(lf(readFileSync(join(s.project(v.id), 'packaging', 'RESOURCES.md'), 'utf8')), /app shot\.png/);

  // Music: a synthesised bed, made once, then a project cue the export and preview mix
  if (!ffmpeg) { t.diagnostic('ffmpeg not found: the bed itself is not made here'); return; }
  const m = await s.ok(`/api/projects/${v.id}/simple-music`, { bed: 'calm', seconds: 12 });
  assert.equal(m.file, 'work/music/calm-12s.m4a');
  const path = join(s.project(v.id), m.file), size = statSync(path).size;
  assert.ok(size > 1000);
  assert.equal((await s.ok(`/api/projects/${v.id}/simple-music`, { bed: 'calm', seconds: 12 })).file, m.file, 'reused');
  assert.equal(statSync(path).size, size);
  assert.match((await s.req(`/api/projects/${v.id}/simple-music`, { bed: 'disco', seconds: 12 })).body.error, /Pick one/);
  const cue = await s.ok(`/api/projects/${v.id}/sfx`, { op: 'add', file: m.file, from: 'project', t: 0, gain: -12, label: 'Music: Calm pad' });
  assert.ok(cue.id);
  assert.ok(!readdirSync(join(s.project(v.id), 'work', 'music')).some((f) => f.includes('.part')), 'no half-made file left');
});
