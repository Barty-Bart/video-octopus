// Design V2 phase B: New video makes "Untitled video" with the last-used style and format, the editor's style picker
// (POST /api/project-context/<id>/select) and automatic naming (the agent's ```octopus-name block and the Packaging
// working title; a rename by hand always wins). Real server in a disposable app and studio copy, with a fake Claude
// Code that never calls a model.
//   node --test test/new-video.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawn, execFileSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { createServer } from 'node:net';
import { cleanName, nameFromReply, namingContext, NAME_MAX } from '../server/naming.mjs';

const APP = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const write = (path, value) => { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, value); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// The fake `claude`: logs the system prompt and each message; a message with NAME-ME:<title> is answered with an
// octopus-name block holding <title>, anything else with a plain reply.
async function fakeClaude() {
  const { appendFileSync, existsSync, readFileSync } = await import('node:fs');
  const { createInterface } = await import('node:readline');
  const argv = process.argv.slice(2);
  const arg = (key) => (argv.includes(key) ? argv[argv.indexOf(key) + 1] : null);
  const log = (item) => appendFileSync(process.env.OCTOPUS_TEST_LOG, JSON.stringify(item) + '\n');
  const out = (item) => process.stdout.write(JSON.stringify(item) + '\n');
  if (argv.includes('--version')) { console.log('9.9.9 fixture'); return; }
  if (argv[0] === 'auth') { console.log('{"loggedIn":true,"authMethod":"claude.ai","subscriptionType":"fixture"}'); return; }
  const file = arg('--append-system-prompt-file');
  log({ kind: 'launch', prompt: file && existsSync(file) ? readFileSync(file, 'utf8') : '' });
  let initialized = false;
  for await (const line of createInterface({ input: process.stdin })) {
    let m; try { m = JSON.parse(line); } catch { continue; }
    if (m.type !== 'user') continue;
    const text = typeof m.message?.content === 'string' ? m.message.content : JSON.stringify(m.message?.content);
    log({ kind: 'message', text });
    if (!initialized) { initialized = true; out({ type: 'system', subtype: 'init', session_id: `fixture-${process.pid}`, model: 'fixture-model' }); }
    if (text.includes('SLOW-ME')) await new Promise((r) => setTimeout(r, 2500)); // a reply still running (Change kit waits)
    const asked = /NAME-ME:([^"\n]+)/.exec(text);
    const reply = asked ? `Sounds good.\n\n\`\`\`octopus-name\n${asked[1].trim()}\n\`\`\`` : 'Fixture reply.';
    out({ type: 'assistant', message: { content: [{ type: 'text', text: reply }] } });
    out({ type: 'result', subtype: 'success', is_error: false, duration_ms: 1 });
  }
}

const freePort = () => new Promise((done, fail) => {
  const s = createServer();
  s.once('error', fail);
  s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => done(port)); });
});

async function startServer(t) {
  const root = mkdtempSync(join(realpathSync(tmpdir()), 'octopus-new-video-'));
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
    claude: { engine: 'claude', lean: true, ccSource: 'plan' }, claudePath: join(bin, 'claude.cmd'),
  }));
  write(join(local, 'schedules.json'), '{"v":1,"schedules":[]}');
  const LOG = join(root, 'wire.jsonl');
  writeFileSync(LOG, '');
  const env = {
    PATH: [bin, dirname(process.execPath), process.env.PATH].join(process.platform === 'win32' ? ';' : ':'),
    HOME: home, USERPROFILE: home, SHELL: shell, TMPDIR: root, TMP: root, TEMP: root, STUDIO_LOCAL_DIR: local, STUDIO_NO_OPEN: '1', STUDIO_NO_SCHEDULES: '1',
    CLAUDE_CONFIG_DIR: join(home, '.claude'), HF_HUB_OFFLINE: '1', PORT: String(port), OCTOPUS_TEST_LOG: LOG, LC_ALL: 'C',
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
  const wire = () => readFileSync(LOG, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  const meta = (id) => JSON.parse(readFileSync(join(studio, 'projects', id, 'project.json'), 'utf8'));
  const settings = () => JSON.parse(readFileSync(join(local, 'settings.json'), 'utf8'));
  const db = (fn) => { const d = new DatabaseSync(join(studio, '.studio/studio.sqlite')); d.exec('PRAGMA busy_timeout=5000'); try { return fn(d); } finally { d.close(); } };
  const until = async (check, what) => {
    for (let i = 0; i < 100; i++) { const v = await check(); if (v) return v; await sleep(50); }
    throw new Error(`Timed out: ${what}\n${logs.slice(-1500)}`);
  };
  return { root, studio, local, url, req, ok, wire, meta, settings, db, until };
}

// Two styles with formats of different video setups, as the picker shows them.
async function styles(s) {
  const L = (path, data) => s.ok(`/api/learning${path}`, data);
  const A = await L('/profiles', { name: 'Tutorials', description: 'Me on camera, teaching with my screen' });
  const B = await L('/profiles', { name: 'Camping', description: '' });
  const FA = await L('/formats', { profileId: A.id, name: 'Tutorial explainer', type: 'tutorial' });
  const FA2 = await L('/formats', { profileId: A.id, name: 'Tutorial Short', type: 'short' });
  const FB = await L('/formats', { profileId: B.id, name: 'Camp explainer', type: 'tutorial' });
  return { A, B, FA, FA2, FB };
}

test('naming helpers: one plain line, at most 60 characters, only from an octopus-name block', () => {
  assert.equal(cleanName('  "Three knots for windy pitches"  '), 'Three knots for windy pitches');
  assert.equal(cleanName('\n\n# My title\nsecond line'), 'My title');
  assert.equal(cleanName(''), null);
  const long = cleanName('word '.repeat(30));
  assert.ok(long.length <= NAME_MAX && !long.endsWith(' '), long);
  assert.equal(nameFromReply('Here you go.\n```octopus-name\nPitching a tent in the wind\n```'), 'Pitching a tent in the wind');
  assert.equal(nameFromReply('A title: "Pitching a tent"'), null, 'plain text never names a video');
  assert.equal(nameFromReply('```octopus-memory\n[]\n```'), null);
  assert.match(namingContext({ nameSource: 'auto', name: 'Untitled video' }), /octopus-name/);
  assert.equal(namingContext({ nameSource: 'manual', name: 'Mine' }), '');
  assert.equal(namingContext({ nameSource: 'auto', name: 'From title', autoNamedBy: 'title' }), '');
});

test('New video: Untitled video with the last-used style and format, a style or format asked for, or No style', async (t) => {
  const s = await startServer(t);
  const c = await styles(s);

  // Nothing used yet: No style, the first video setup, an automatic name, and the hub's description is kept.
  const first = await s.ok('/api/projects', { untitled: true });
  assert.equal(first.id, 'untitled-video');
  let m = s.meta(first.id);
  assert.equal(m.name, 'Untitled video');
  assert.equal(m.nameSource, 'auto');
  assert.equal(m.type, 'tutorial');
  assert.equal(m.context.profileId, null);
  const profiles = await s.ok('/api/profiles');
  assert.equal(profiles.profiles.find((p) => p.id === c.A.id).description, 'Me on camera, teaching with my screen');

  // A format asked for: that format, its style and its video setup; it becomes the last used.
  const short = await s.ok('/api/projects', { untitled: true, formatId: c.FA2.id });
  assert.equal(short.id, 'untitled-video-2', 'the folder is de-duplicated, the name stays the same');
  m = s.meta(short.id);
  assert.equal(m.name, 'Untitled video');
  assert.equal(m.type, 'short');
  assert.deepEqual([m.context.profileId, m.context.formatId], [c.A.id, c.FA2.id]);
  assert.deepEqual(s.settings().lastNewVideo, { profileId: c.A.id, formatId: c.FA2.id });

  // Nothing asked for: the last used style and format.
  const again = await s.ok('/api/projects', { untitled: true });
  assert.deepEqual([s.meta(again.id).context.profileId, s.meta(again.id).context.formatId], [c.A.id, c.FA2.id]);

  // A style asked for (its hub's New video): its first format unless the last used one is one of its own.
  const camp = await s.ok('/api/projects', { untitled: true, profileId: c.B.id });
  assert.deepEqual([s.meta(camp.id).context.profileId, s.meta(camp.id).context.formatId], [c.B.id, c.FB.id]);
  const tut = await s.ok('/api/projects', { untitled: true, profileId: c.A.id });
  assert.equal(s.meta(tut.id).context.formatId, c.FA.id, 'the last used was Camping\'s format, so Tutorials starts with its first');

  // No style asked for.
  const none = await s.ok('/api/projects', { untitled: true, profileId: null });
  assert.equal(s.meta(none.id).context.profileId, null);
  assert.deepEqual(s.settings().lastNewVideo, { profileId: null, formatId: null });

  // An archived style is not used again by itself, and refused when asked for.
  await s.ok('/api/projects', { untitled: true, formatId: c.FB.id });
  // Flat 3: a brand kit that a style still uses can't be archived until that style moves or is archived.
  const used = await s.req(`/api/learning/profiles/${c.B.id}/archive`, { expected: 1 });
  assert.equal(used.status, 400);
  assert.match(used.body.error, /Camp explainer/);
  await s.ok(`/api/learning/formats/${c.FB.id}/archive`, { expected: 1 });
  await s.ok(`/api/learning/profiles/${c.B.id}/archive`, { expected: 1 });
  const after = await s.ok('/api/projects', { untitled: true });
  assert.equal(s.meta(after.id).context.profileId, null, 'the remembered style is archived: No style');
  const refused = await s.req('/api/projects', { untitled: true, profileId: c.B.id });
  assert.equal(refused.status, 400);
  assert.match(refused.body.error, /archived/);

  // The project list says how far each video is, for Home's tiles and hero.
  const list = await s.ok('/api/projects');
  const row = list.find((p) => p.id === first.id);
  assert.equal(row.nameSource, 'auto');
  assert.equal(row.hasTake, false);
  assert.equal(row.exported, false);
  assert.equal(row.stage, 'Record');
  assert.ok(row.stageIndex >= 1 && row.stageCount >= row.stageIndex);
  // Every step that must be done is done (each by its own done rule in core/pipelines.json); an optional one (Package)
  // never was: the tile says Done, not the optional step's stage.
  const pipes = JSON.parse(readFileSync(join(APP, 'core', 'pipelines.json'), 'utf8'));
  const dir = join(s.studio, 'projects', first.id), type = s.meta(first.id).type;
  const steps = pipes.formats[type].steps.map((x) => (typeof x === 'string' ? { id: x, ...pipes.shared[x] } : x));
  let worklog = '';
  for (const st of steps.filter((x) => !x.optional)) {
    const d = st.done || {}, put = (rel, text) => { mkdirSync(dirname(join(dir, rel)), { recursive: true }); writeFileSync(join(dir, rel), text); };
    if (d.files?.length) put(d.files[0].replaceAll('*', 'x'), 'x');
    else if (Array.isArray(d.json)) put(d.json[0], JSON.stringify({ [d.json[1]]: true }));
    else if (d.worklog) worklog += `- ${d.worklog}\n`;
  }
  writeFileSync(join(dir, 'WORKLOG.md'), worklog);
  assert.ok(steps.some((x) => x.optional), 'the style has an optional step');
  const done = (await s.ok('/api/projects')).find((p) => p.id === first.id);
  assert.equal(done.next, null);
  assert.equal(done.stage, null, 'an optional step left undone is not where the video is');
  assert.equal(done.stageIndex, null);
  const counts = await s.ok('/api/app/counts');
  assert.deepEqual(counts.waiting, { memories: 0, drafts: { count: 0, formatId: null } });
  assert.equal(counts.channels.find((x) => x.id === c.A.id).description, 'Me on camera, teaching with my screen');
});

test('style picker: re-pins as New video does, free before Build, confirmation after, never across setups after Build', async (t) => {
  const s = await startServer(t);
  const c = await styles(s);
  const { id } = await s.ok('/api/projects', { untitled: true, profileId: null });
  const pin = () => s.db((d) => JSON.parse(d.prepare('SELECT data FROM project_context WHERE project=?').get(id).data));
  const selection = () => JSON.parse(readFileSync(join(s.studio, 'projects', id, '.octopus/context/selection.json'), 'utf8'));

  // Before Build: picked freely, pinned in the database, project.json and the context files.
  let r = await s.ok(`/api/project-context/${id}/select`, { profileId: c.A.id, formatId: c.FA.id });
  assert.equal(r.built, false);
  assert.deepEqual([pin().profileId, pin().formatId], [c.A.id, c.FA.id]);
  assert.equal(s.meta(id).context.formatId, c.FA.id);
  assert.equal(selection().formatId, c.FA.id);
  assert.equal((await s.ok(`/api/projects/${id}`)).context.formatName, 'Tutorial explainer');
  assert.deepEqual(s.settings().lastNewVideo, { profileId: c.A.id, formatId: c.FA.id }, 'the picker remembers the last used style');

  // Another video setup before Build: the project follows the format's setup (a Short is 9:16).
  r = await s.ok(`/api/project-context/${id}/select`, { formatId: c.FA2.id });
  assert.equal(r.typeChanged, true);
  assert.equal(s.meta(id).type, 'short');
  assert.equal(s.meta(id).layout.aspect, '9:16');
  r = await s.ok(`/api/project-context/${id}/select`, { formatId: c.FA.id });
  assert.equal(s.meta(id).type, 'tutorial');

  // A format of another style is refused when the style doesn't match.
  const wrong = await s.req(`/api/project-context/${id}/select`, { profileId: c.B.id, formatId: c.FA.id });
  assert.equal(wrong.status, 400);

  // No style.
  await s.ok(`/api/project-context/${id}/select`, { profileId: null, formatId: null });
  assert.deepEqual([pin().profileId, pin().formatId], [null, null]);

  // After Build (the intro is rendered): refused without confirm, with the message the dialog shows.
  write(join(s.studio, 'projects', id, 'renders', `${id}_intro.mp4`), 'synthetic');
  const held = await s.req(`/api/project-context/${id}/select`, { profileId: c.B.id, formatId: c.FB.id });
  assert.equal(held.status, 409);
  assert.equal(held.body.needsConfirm, true);
  assert.match(held.body.error, /Videos keep the style they were built with/);
  assert.equal(pin().profileId, null, 'nothing changed');
  r = await s.ok(`/api/project-context/${id}/select`, { profileId: c.B.id, formatId: c.FB.id, confirm: true });
  assert.equal(r.built, true);
  assert.deepEqual([pin().profileId, pin().formatId], [c.B.id, c.FB.id]);
  // After Build, another video setup is refused even with confirm.
  const setup = await s.req(`/api/project-context/${id}/select`, { formatId: c.FA2.id, confirm: true });
  assert.equal(setup.status, 400);
  assert.match(setup.body.error, /same video setup/);
  assert.equal(s.meta(id).type, 'tutorial');
  assert.ok(readFileSync(join(s.studio, 'projects', id, 'WORKLOG.md'), 'utf8').includes('Style changed to Camping · Camp explainer after Build'));
  const missing = await s.req('/api/project-context/no-such-video/select', { profileId: null });
  assert.equal(missing.status, 404);
});

test('AI naming: the agent names an automatic video, the working title too, and a rename by hand always wins', async (t) => {
  const s = await startServer(t);
  const { id } = await s.ok('/api/projects', { untitled: true });

  // The project agent is asked to propose a name while it is automatic.
  await s.ok(`/api/projects/${id}/chat`, { text: 'It is about pitching a tent in the wind.' });
  await s.until(() => s.wire().some((w) => w.kind === 'message'), 'the first message');
  assert.match(s.wire().find((w) => w.kind === 'launch').prompt, /octopus-name/);

  // Untrusted text in the creator's own message never names the video; the agent's block does.
  assert.equal(s.meta(id).name, 'Untitled video');
  // Listen to the project's events: the page hears the new name, and the rename is not offered as the agent's Undo.
  const stop = new AbortController();
  let events = '';
  const stream = fetch(`${s.url}/api/projects/${id}/events`, { signal: stop.signal }).then(async (r) => {
    for await (const chunk of r.body) events += Buffer.from(chunk).toString();
  }).catch(() => {});
  await sleep(300);
  await s.ok(`/api/projects/${id}/chat`, { text: 'NAME-ME: Pitching a tent in the wind' });
  await s.until(() => s.meta(id).name === 'Pitching a tent in the wind', 'the agent\'s name');
  await s.until(() => events.includes('"t":"busy","busy":false') && events.includes('"t":"renamed"'), 'the end of the turn');
  await sleep(300);
  stop.abort();
  await stream;
  assert.match(events, /"t":"renamed","name":"Pitching a tent in the wind","by":"agent"/);
  assert.doesNotMatch(events, /undo-offer/, 'an automatic name is not the agent\'s file change');
  assert.equal(s.meta(id).nameSource, 'auto');
  assert.equal(s.meta(id).autoNamedBy, 'agent');
  assert.ok(existsSync(join(s.studio, 'projects', id)), 'the folder stays the same');
  assert.equal((await s.ok('/api/projects')).find((p) => p.id === id).name, 'Pitching a tent in the wind');

  // The Packaging working title renames it again; after that the agent's proposals don't replace it.
  const titled = await s.ok(`/api/packaging/${id}/title`, { title: 'Tents vs wind: 3 knots that hold' });
  assert.equal(titled.renamed, 'Tents vs wind: 3 knots that hold');
  assert.equal(s.meta(id).autoNamedBy, 'title');
  await s.ok(`/api/projects/${id}/chat`, { text: 'NAME-ME: Agent second idea' });
  await s.until(() => s.wire().filter((w) => w.kind === 'message').some((w) => w.text.includes('Agent second idea')), 'the second proposal');
  await sleep(400);
  assert.equal(s.meta(id).name, 'Tents vs wind: 3 knots that hold');

  // A rename by hand wins over both triggers from then on.
  await s.ok(`/api/projects/${id}/rename`, { name: 'My own name' });
  assert.equal(s.meta(id).nameSource, 'manual');
  const later = await s.ok(`/api/packaging/${id}/title`, { title: 'A newer working title' });
  assert.equal(later.renamed, null);
  await s.ok(`/api/projects/${id}/chat`, { text: 'NAME-ME: Agent third idea' });
  await s.until(() => s.wire().filter((w) => w.kind === 'message').some((w) => w.text.includes('Agent third idea')), 'the third proposal');
  await sleep(400);
  assert.equal(s.meta(id).name, 'My own name');

  // A project made with a name is manual from the start: the agent's block never renames it.
  const named = await s.ok('/api/projects', { name: 'Named by me', type: 'tutorial' });
  assert.equal(s.meta(named.id).nameSource, undefined);
  await s.ok(`/api/projects/${named.id}/chat`, { text: 'NAME-ME: Not this one' });
  await s.until(() => s.wire().filter((w) => w.kind === 'message').some((w) => w.text.includes('Not this one')), 'the proposal');
  await sleep(400);
  assert.equal(s.meta(named.id).name, 'Named by me');
  assert.equal((await s.ok('/api/projects')).find((p) => p.id === named.id).nameSource, 'manual');
});

// Flat 3 Change kit: POST /api/learning/formats/<id>/move { profileId, expected }. The style (format) moves to another
// kit; its drafts and conversations go with it (their memories follow it to the new kit), while videos made before
// keep the kit, brand and memories they pinned. Refused with a stale revision and while a conversation is working.
test('Change kit: a style moves, its videos keep their pins, its conversations follow, No brand is one hidden kit', async (t) => {
  const s = await startServer(t);
  const c = await styles(s);
  const brandA = await s.ok(`/api/profiles/${c.A.id}/brand`, { brand: { identity: 'Tutorials brand', colors: ['#1d4ed8'] }, expected: null });
  const video = await s.ok('/api/projects', { untitled: true, formatId: c.FA.id });
  const pin = () => s.db((d) => JSON.parse(d.prepare('SELECT data FROM project_context WHERE project=?').get(video.id).data));
  const chatRow = (id) => s.db((d) => { const r = d.prepare('SELECT data FROM memory_chats WHERE id=?').get(id); return r ? JSON.parse(r.data) : null; });
  const before = pin();
  assert.deepEqual([before.profileId, before.brandVersion, before.formatId], [c.A.id, brandA.id, c.FA.id]);
  // The video's chat registers its memory scopes with kit A.
  await s.ok(`/api/projects/${video.id}/chat`, { text: 'hello from the video' });
  await s.until(() => chatRow(video.id), 'the video chat binding');
  // A draft (a direct rule edit) in a conversation of the style.
  const draft = await s.ok(`/api/learning/formats/${c.FA.id}/draft-rule`, { area: 'visuals', text: 'Progress bar in blue.' });
  const sid = draft.session.id;

  // While the style's conversation is replying: refused.
  const replying = s.req(`/api/learning/sessions/${sid}/chat`, { text: 'SLOW-ME think about pacing' });
  await s.until(() => s.wire().some((w) => w.kind === 'message' && w.text.includes('SLOW-ME')), 'the slow reply');
  let f = (await s.ok('/api/learning')).formats.find((x) => x.id === c.FA.id);
  const busy = await s.req(`/api/learning/formats/${c.FA.id}/move`, { profileId: c.B.id, expected: f.revision });
  assert.equal(busy.status, 409);
  assert.match(busy.body.error, /still working/);
  await replying;
  await s.until(async () => (await s.ok(`/api/learning/sessions/${sid}`)).status !== 'running', 'the reply to finish');
  assert.deepEqual(chatRow(`_learning_${sid}`).scopes, ['global', `profile:${c.A.id}`, `format:${c.FA.id}`]);

  // A stale revision is refused; the current one moves the style to kit B.
  const stale = await s.req(`/api/learning/formats/${c.FA.id}/move`, { profileId: c.B.id, expected: f.revision - 1 });
  assert.equal(stale.status, 400);
  assert.match(stale.body.error, /changed/);
  const moved = await s.ok(`/api/learning/formats/${c.FA.id}/move`, { profileId: c.B.id, expected: f.revision });
  assert.equal(moved.profileId, c.B.id);
  assert.equal(s.db((d) => d.prepare('SELECT profile_id FROM formats WHERE id=?').get(c.FA.id).profile_id), c.B.id);

  // The video keeps its pin (kit A, A's brand version), its context files, its resources and its chat's memories.
  assert.deepEqual(pin(), before);
  assert.equal(s.meta(video.id).context.profileId, c.A.id);
  const context = await s.ok(`/api/project-context/${video.id}`);
  assert.equal(context.bundle.brandVersion, brandA.id);
  assert.deepEqual(chatRow(video.id).scopes, ['global', `profile:${c.A.id}`, `format:${c.FA.id}`, `project:${video.id}`]);
  const levels = (await s.ok(`/api/resources?project=${video.id}`)).levels.map((l) => l.scope);
  assert.deepEqual(levels, ['global', `profile:${c.A.id}`, `project:${video.id}`], 'the video still sees kit A, never kit B');
  const wires = s.wire().filter((w) => w.kind === 'message').length;
  await s.ok(`/api/projects/${video.id}/chat`, { text: 'still here after the move' });
  await s.until(() => s.wire().filter((w) => w.kind === 'message').length > wires, 'the video chat after the move');
  assert.deepEqual(chatRow(video.id).scopes[1], `profile:${c.A.id}`, 'no "memory scope changed": the video stays on kit A');

  // The style's conversation follows it to kit B; its draft stays with the style.
  assert.deepEqual(chatRow(`_learning_${sid}`).scopes, ['global', `profile:${c.B.id}`, `format:${c.FA.id}`]);
  const proposal = await s.ok(`/api/learning/sessions/${sid}/proposal`);
  assert.ok(proposal.rules.some((r) => r.text === 'Progress bar in blue.'));
  // A new video in the style now pins kit B.
  const next = await s.ok('/api/projects', { untitled: true, formatId: c.FA.id });
  assert.deepEqual([s.meta(next.id).context.profileId, s.meta(next.id).context.brandVersion], [c.B.id, null]);
  // Same kit again: refused.
  f = (await s.ok('/api/learning')).formats.find((x) => x.id === c.FA.id);
  assert.equal((await s.req(`/api/learning/formats/${c.FA.id}/move`, { profileId: c.B.id, expected: f.revision })).status, 400);

  // No brand: one hidden built-in kit, made once, never listed as a kit, never renamed, archived or branded.
  const plain = await s.ok(`/api/learning/formats/${c.FA2.id}/move`, { profileId: null, expected: 1 });
  const unbranded = (await s.ok('/api/learning')).profiles.filter((p) => p.system === 'unbranded');
  assert.equal(unbranded.length, 1);
  assert.equal(plain.profileId, unbranded[0].id);
  assert.equal(unbranded[0].name, 'No brand');
  const made = await s.ok('/api/learning/formats', { profileId: null, name: 'Product demo', type: 'explainer', description: 'Screen recording, zooms.' });
  assert.equal(made.profileId, unbranded[0].id, 'the same hidden kit, not a second one');
  assert.equal(made.description, 'Screen recording, zooms.');
  assert.equal((await s.ok('/api/learning')).profiles.filter((p) => p.system).length, 1);
  assert.ok(!(await s.ok('/api/app/counts')).channels.some((k) => k.id === unbranded[0].id), 'not a kit in the sidebar or My styles');
  for (const [path, body] of [
    [`/api/learning/profiles/${unbranded[0].id}/update`, { expected: 1, name: 'Mine' }],
    [`/api/learning/profiles/${unbranded[0].id}/archive`, { expected: 1 }],
    [`/api/profiles/${unbranded[0].id}/brand`, { brand: { identity: 'x' }, expected: null }],
  ]) assert.equal((await s.req(path, body)).status, 400, path);
  // A video in an unbranded style: no kit rung for memories or resources.
  const demo = await s.ok('/api/projects', { untitled: true, formatId: made.id });
  assert.deepEqual((await s.ok(`/api/resources?project=${demo.id}`)).levels.map((l) => l.scope), ['global', `project:${demo.id}`]);
  // And back from No brand to a real kit.
  const back = await s.ok(`/api/learning/formats/${c.FA2.id}/move`, { profileId: c.A.id, expected: plain.revision });
  assert.equal(back.profileId, c.A.id);
  // Duplicate: a basic style gets a basic copy in the same kit, with its description and skills.
  const copy = await s.ok(`/api/learning/formats/${made.id}/duplicate`, { expected: made.revision });
  assert.deepEqual([copy.profileId, copy.name, copy.description, copy.activeVersion], [made.profileId, 'Product demo copy', 'Screen recording, zooms.', null]);
});
