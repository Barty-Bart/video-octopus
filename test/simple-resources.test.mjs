// V1 "ultra simple" step 5: the Resources page (handoff v1-simple-2026-10-26/SPEC.md §4, server/simple-resources.mjs,
// web/resource-kinds.js). The kinds and their rules (pure); then on a real server in a disposable app and studio copy,
// with a fake agent that never calls a model or the network: uploads of the five kinds (each checked against its
// extension and its first bytes), rename and Use as, Remove to the studio's trash with Undo (and Put back on the Trash
// page), look edits as brand versions on the built-in profile, Get my look from my website (the brand research, saved
// only on approval), and what the agents see (RESOURCES.md and its copies, the pinned brand and assets, the project
// chat's instructions). Windows-safe: forward-slash paths, plain file names, CRLF normalised.
//   node --test test/simple-resources.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawn, execFileSync } from 'node:child_process';
import { createServer } from 'node:net';
import { png } from './png-fixture.mjs';
import { SIMPLE_KINDS, guessKind, simpleKindOf, resourceFields, fitsKind, renamed, lookColors } from '../web/resource-kinds.js';

const APP = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const write = (path, value) => { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, value); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const lf = (s) => String(s).replace(/\r\n/g, '\n');

// ---------- the kinds (web/resource-kinds.js) ----------
test('Resources kinds: fonts, clips and logos are known by name; any other picture asks', () => {
  assert.equal(guessKind('Brand Bold.woff2'), 'font');
  assert.equal(guessKind('office walk.MOV'), 'clip');
  assert.equal(guessKind('mark.svg'), 'logo');
  assert.equal(guessKind('acme-logo.png'), 'logo');
  assert.equal(guessKind('me at my desk.jpg'), null, 'a photo asks "Is this a photo of you?"');
  assert.equal(guessKind('catalogue.jpg'), null);
  assert.equal(guessKind('notes.pdf'), 'unsupported');
  assert.deepEqual(resourceFields('photo'), { kind: 'photo', likeness: 'self', use: 'always' }, 'photos of you go to every thumbnail');
  assert.deepEqual(resourceFields('clip'), { kind: 'clip', likeness: 'nobody', use: 'ask' });
  assert.throws(() => resourceFields('poster'), /Choose what this is/);
  assert.equal(simpleKindOf({ kind: 'photo', likeness: 'self' }), 'photo');
  assert.equal(simpleKindOf({ kind: 'photo', likeness: 'other' }), null, 'someone else is not "a photo of you"');
  assert.equal(simpleKindOf({ kind: 'reference' }), null);
  assert.equal(simpleKindOf({ kind: 'product' }), 'product');
  assert.ok(fitsKind('a.png', 'logo') && fitsKind('a.png', 'product') && !fitsKind('a.png', 'font') && !fitsKind('a.mp4', 'photo'));
  assert.equal(renamed('Me at my desk', '.jpg'), 'Me at my desk.jpg');
  assert.equal(renamed('logo.svg', '.svg'), 'logo.svg');
  assert.throws(() => renamed('  ', '.png'), /name/);
  assert.deepEqual(lookColors('#1D4ED8', ['#18181b', '#1d4ed8', 'red', '#facc15']), ['#1d4ed8', '#18181b', '#facc15'], 'main first, no repeats, hex only');
  assert.deepEqual(Object.keys(SIMPLE_KINDS), ['logo', 'font', 'photo', 'product', 'clip']);
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
async function startServer(t) {
  const root = mkdtempSync(join(realpathSync(tmpdir()), 'octopus-resources-'));
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
    claude: { engine: 'claude', lean: true, ccSource: 'plan' }, claudePath: join(bin, 'claude.cmd'),
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
const SVG = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><rect width="10" height="10" fill="#1d4ed8"/></svg>');
const WOFF2 = Buffer.concat([Buffer.from('wOF2'), Buffer.alloc(60, 1)]);
const MP4 = Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from('ftypisom'), Buffer.alloc(4096, 7)]);

test('server: Resources uploads the five kinds, renames, changes kind, removes to the trash with Undo; agents see it', async (t) => {
  const s = await startServer(t);
  // Opening the page before anything exists writes nothing: no built-in profile yet.
  assert.deepEqual((await s.ok('/api/simple-resources')).profileId, null);
  assert.equal((await s.ok('/api/profiles')).profiles.some((p) => p.system === 'default'), false);

  const yt = await s.ok('/api/projects', { untitled: true, shape: 'youtube' });
  const built = await s.ok('/api/projects', { untitled: true, shape: 'reel' });
  write(join(s.project(built.id), 'renders', `${built.id}_short_v1.mp4`), 'fixture render'); // Build has run

  // Uploads: each kind, each checked against its extension and its first bytes.
  const logo = await s.ok(`/api/simple-resources/upload?${new URLSearchParams({ name: 'logo.svg', kind: 'logo' })}`, undefined, SVG);
  assert.deepEqual([logo.kind, logo.line], ['logo', 'Your logo']);
  const photo = (await s.upload('desk.png', 'photo', PNG)).body;
  assert.deepEqual([photo.kind, photo.line], ['photo', 'Used in thumbnails']);
  const product = (await s.upload('app shot.png', 'product', PNG)).body;
  const font = (await s.upload('Brand Bold.woff2', 'font', WOFF2)).body;
  const clip = (await s.upload('office walk.mp4', 'clip', MP4)).body;
  assert.deepEqual([product.kind, font.kind, clip.kind], ['product', 'font', 'clip']);
  for (const [name, kind, bytes, why] of [['fake.png', 'photo', Buffer.from('not a picture at all'), /doesn’t look like a \.png/], ['Brand.woff2', 'photo', WOFF2, /picture/],
    ['x.png', 'poster', PNG, /Choose what this is/], ['empty.png', 'product', Buffer.alloc(0), /empty/]]) {
    const r = await s.upload(name, kind, bytes);
    assert.equal(r.status, 400, name);
    assert.match(r.body.error, why, name);
  }

  let v = await s.ok('/api/simple-resources');
  assert.ok(v.profileId);
  assert.deepEqual(v.files.map((f) => f.name), ['office walk.mp4', 'Brand Bold.woff2', 'app shot.png', 'desk.png', 'logo.svg'], 'newest first');
  assert.deepEqual([...v.look.assets].sort(), [logo.id, font.id].sort(), 'the look names the logo and font files');
  const profiles = await s.ok('/api/profiles');
  const mine = profiles.profiles.find((p) => p.id === v.profileId);
  assert.equal(mine.system, 'default', 'stored on the built-in profile');
  assert.equal(s.meta(yt.id).context.profileId, v.profileId);

  // Previews: the file itself, never run as a page; a clip answers ranges.
  const pic = await fetch(`${s.url}/api/simple-resources/${logo.id}/file`);
  assert.equal(pic.headers.get('content-type'), 'image/svg+xml');
  assert.match(pic.headers.get('content-security-policy'), /sandbox/);
  assert.equal(Buffer.from(await pic.arrayBuffer()).toString(), SVG.toString());
  const part = await fetch(`${s.url}/api/simple-resources/${clip.id}/file`, { headers: { Range: 'bytes=4-11' } });
  assert.equal(part.status, 206);
  assert.equal(Buffer.from(await part.arrayBuffer()).toString(), 'ftypisom');

  // Rename keeps the extension; Use as changes a picture's kind; a clip can't become a photo.
  const named = await s.ok(`/api/simple-resources/${photo.id}`, { name: 'Me at my desk', expected: photo.revision });
  assert.equal(named.name, 'Me at my desk.png');
  const asLogo = await s.ok(`/api/simple-resources/${product.id}`, { kind: 'logo', expected: product.revision });
  assert.equal(asLogo.kind, 'logo');
  const back = await s.ok(`/api/simple-resources/${product.id}`, { kind: 'product', expected: asLogo.revision });
  assert.equal(back.kind, 'product');
  const refused = await s.req(`/api/simple-resources/${clip.id}`, { kind: 'photo', expected: clip.revision });
  assert.equal(refused.status, 400);
  const stale = await s.req(`/api/simple-resources/${photo.id}`, { name: 'Old', expected: photo.revision });
  assert.match(stale.body.error, /changed/, 'a stale revision is refused');

  // What the agents see. RESOURCES.md lists every file, with copies under packaging/resources/ (also for a built video:
  // files are live), and the pinned context of a video without Build names the logo and font and holds their copies.
  const md = lf(readFileSync(join(s.project(yt.id), 'packaging', 'RESOURCES.md'), 'utf8'));
  for (const line of ['**Me at my desk.png** (Photo · who is in it: Me · use in every thumbnail)', '**office walk.mp4** (Video clip', '**app shot.png** (Product', '**logo.svg** (Logo', '**Brand Bold.woff2** (Font']) {
    assert.ok(md.includes(line), `${line}\n${md}`);
  }
  const copies = readdirSync(join(s.project(yt.id), 'packaging', 'resources', 'channel'));
  assert.equal(copies.length, 5);
  assert.ok(copies.some((n) => n.endsWith('-office walk.mp4')));
  assert.ok(lf(readFileSync(join(s.project(built.id), 'packaging', 'RESOURCES.md'), 'utf8')).includes('Me at my desk.png'), 'a built video sees files too');
  const ctx = join(s.project(yt.id), '.octopus', 'context');
  assert.deepEqual([...JSON.parse(readFileSync(join(ctx, 'brand.json'), 'utf8')).assets].sort(), [logo.id, font.id].sort());
  assert.ok(existsSync(join(ctx, 'assets', `${logo.id}-logo.svg`)));
  assert.equal(s.meta(built.id).context.brandVersion, null, 'a built video keeps the look it was built with');

  // The project chat's instructions point at RESOURCES.md (the agent's own system prompt, from the fake's log).
  await s.ok(`/api/projects/${yt.id}/chat`, { text: 'What do you have of mine?' });
  const launch = await s.until(() => s.agentLog().find((x) => x.kind === 'launch' && x.cwd.replaceAll('\\', '/').endsWith(`/projects/${yt.id}`)), 'the project chat');
  assert.match(launch.prompt, /The creator's Resources \(their logo, fonts, photos of them, products and clips/);
  assert.match(launch.prompt, /packaging\/RESOURCES\.md/);
  assert.match(launch.prompt, new RegExp(`"assets":\\[[^\\]]*"${logo.id}"`), 'the approved brand names the logo');

  // Remove: archived (never deleted) with a trash entry; Undo brings it back; the Trash page lists and puts back too.
  const gone = await s.ok(`/api/simple-resources/${clip.id}/remove`, { expected: clip.revision });
  assert.ok(gone.trash);
  v = await s.ok('/api/simple-resources');
  assert.equal(v.files.some((f) => f.id === clip.id), false);
  const entry = join(s.studio, '.trash', gone.trash);
  assert.equal(JSON.parse(readFileSync(join(entry, 'manifest.json'), 'utf8')).kind, 'resource-removed');
  assert.ok(!lf(readFileSync(join(s.project(yt.id), 'packaging', 'RESOURCES.md'), 'utf8')).includes('office walk.mp4'), 'agents stop seeing it');
  const store = readdirSync(join(s.studio, '.studio', 'files'), { recursive: true }).filter((n) => n.endsWith('.mp4'));
  assert.equal(store.length, 1, 'its bytes stay in the file store');
  let trash = await s.ok('/api/trash');
  const item = trash.items.find((x) => x.trash === gone.trash);
  assert.deepEqual([item.what, item.restorable, item.name], ['Removed from Resources', true, 'office walk.mp4']);
  await s.ok('/api/simple-resources/restore', { trash: gone.trash });
  assert.ok((await s.ok('/api/simple-resources')).files.some((f) => f.id === clip.id), 'Undo');
  assert.equal(existsSync(entry), false, 'the entry left the trash');
  assert.ok(lf(readFileSync(join(s.project(yt.id), 'packaging', 'RESOURCES.md'), 'utf8')).includes('office walk.mp4'));
  assert.equal((await s.req('/api/simple-resources/restore', { trash: gone.trash })).status, 400, 'twice is refused');

  // Removing the logo takes it out of the look (a new brand version); Put back on the Trash page restores both.
  const before = (await s.ok('/api/simple-resources')).brandVersion;
  const logoGone = await s.ok(`/api/simple-resources/${logo.id}/remove`, {});
  v = await s.ok('/api/simple-resources');
  assert.notEqual(v.brandVersion, before);
  assert.deepEqual(v.look.assets, [font.id]);
  trash = await s.ok('/api/trash');
  assert.ok(trash.items.find((x) => x.trash === logoGone.trash).restorable);
  await s.ok('/api/trash/restore', { trash: logoGone.trash });
  v = await s.ok('/api/simple-resources');
  assert.deepEqual([...v.look.assets].sort(), [logo.id, font.id].sort());
  assert.equal((await s.ok('/api/trash')).items.some((x) => x.trash === logoGone.trash), false);
  // An emptied trash leaves the record archived (hidden, never deleted): it just can't come back from there.
  const again = await s.ok(`/api/simple-resources/${photo.id}/remove`, {});
  await s.ok('/api/trash/empty', { confirm: true });
  assert.equal((await s.req('/api/simple-resources/restore', { trash: again.trash })).status, 400);
  const raw = (await s.ok(`/api/resources?project=${yt.id}`)).levels.flatMap((l) => l.items);
  assert.equal(raw.some((r) => r.id === photo.id), false, 'archived resources are not listed');
});

test('server: look edits are brand versions; Get my look runs brand research and saves only on Use this look', async (t) => {
  const s = await startServer(t);
  const fresh = await s.ok('/api/projects', { untitled: true, shape: 'youtube' });
  const built = await s.ok('/api/projects', { untitled: true, shape: 'youtube' });
  write(join(s.project(built.id), 'renders', `${built.id}_intro_v1.mp4`), 'fixture render');

  // Edit: colours (main first), font and voice → a brand version on the built-in profile; earlier fields are kept.
  const v1 = await s.ok('/api/simple-resources/look', { colors: ['#1D4ED8', '#18181b', '#facc15'], fonts: 'Geist', voice: 'Friendly, plain voice', expected: null });
  let view = await s.ok('/api/simple-resources');
  assert.equal(view.brandVersion, v1.id);
  assert.deepEqual(view.look, { colors: ['#1d4ed8', '#18181b', '#facc15'], fonts: 'Geist', voice: 'Friendly, plain voice', assets: [] });
  const stale = await s.req('/api/simple-resources/look', { colors: ['#000000'], expected: null });
  assert.match(stale.body.error, /Brand changed/, 'a stale edit is refused');
  const v2 = await s.ok('/api/simple-resources/look', { voice: 'Calm and short', expected: v1.id });
  assert.deepEqual((await s.ok('/api/simple-resources')).look.colors, ['#1d4ed8', '#18181b', '#facc15'], 'colours kept when only the voice changes');

  // Videos without Build follow the new look (their pin, context files and worklog); a built one keeps its own.
  assert.equal(s.meta(fresh.id).context.brandVersion, v2.id);
  assert.equal(JSON.parse(readFileSync(join(s.project(fresh.id), '.octopus', 'context', 'brand.json'), 'utf8')).voice, 'Calm and short');
  assert.match(lf(readFileSync(join(s.project(fresh.id), 'WORKLOG.md'), 'utf8')), /Your look changed in Resources/);
  assert.equal(s.meta(built.id).context.brandVersion, null);
  // A new video starts with the current look; the kit colour (covers, dots) is its first colour.
  const next = await s.ok('/api/projects', { untitled: true, shape: 'reel' });
  assert.equal(s.meta(next.id).context.brandVersion, v2.id);
  const history = (await s.ok('/api/profiles')).profiles.find((p) => p.system === 'default').history;
  assert.deepEqual(history.map((x) => x.reason), ['Your look, edited in Resources', 'Your look, edited in Resources']);

  // Get my look from my website: the brand research on the built-in profile (fake agent, no network).
  const { profileId } = await s.ok('/api/simple-resources/profile', {});
  assert.equal(profileId, (await s.ok('/api/simple-resources')).profileId);
  const r = await s.ok(`/api/profiles/${profileId}/research`, { url: 'https://example.com', direction: 'Simple' });
  await s.ok(`/api/profile-research/${r.id}/run`, { revision: r.revision });
  const done = await s.until(async () => { const x = await s.ok(`/api/profile-research/${r.id}`); return x.status === 'review' && x; }, 'the research proposal');
  const proposal = await s.ok(`/api/profile-research/${r.id}/proposal`);
  assert.deepEqual(proposal.brand.colors, ['#0f766e', '#f59e0b']);
  view = await s.ok('/api/simple-resources');
  assert.deepEqual(view.research, { id: r.id, url: 'https://example.com/', status: 'review', error: null, revision: done.revision });
  assert.equal(view.brandVersion, v2.id, 'nothing saved before Use this look');
  // A logo uploaded meanwhile stays in the approved look.
  const logo = (await s.upload('mark.svg', 'logo', SVG)).body;
  const v3 = await s.ok(`/api/simple-resources/research/${r.id}/approve`, { revision: proposal.revision, token: proposal.token });
  view = await s.ok('/api/simple-resources');
  assert.equal(view.brandVersion, v3.id);
  assert.deepEqual(view.look, { colors: ['#0f766e', '#f59e0b'], fonts: 'Inter for text', voice: 'Plain, friendly, a bit dry', assets: [logo.id] });
  assert.equal(view.research.status, 'approved');
  assert.equal(s.meta(fresh.id).context.brandVersion, v3.id, 'videos without Build follow');
  // Research for another kit can't be approved here.
  const kit = await s.ok('/api/learning/profiles', { name: 'Tutorials' });
  const other = await s.ok(`/api/profiles/${kit.id}/research`, { url: 'https://example.org' });
  const wrong = await s.req(`/api/simple-resources/research/${other.id}/approve`, { revision: 1, token: 'x' });
  assert.match(wrong.body.error, /another brand/);
});
