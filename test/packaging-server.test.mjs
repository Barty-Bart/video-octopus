// Packaging through the real server, with a FAKE Codex app-server that answers image turns with imageGeneration items
// (a synthetic 3 × 2 PNG at savedPath, or a usageLimitExceeded failure). No real agent, model, credential or network.
//   node --test test/packaging-server.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawn, execFileSync } from 'node:child_process';
import { createServer } from 'node:net';
import { png, sheetPng } from './png-fixture.mjs';

const APP = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const write = (path, value) => { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, value); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const pngSize = (b) => ({ width: b.readUInt32BE(16), height: b.readUInt32BE(20) });

// The fake `codex`: --version, login status, and app-server over stdio. Image turns write a PNG made by the test
// (OCTOPUS_TEST_SHEET / OCTOPUS_TEST_SQUARE) to $CODEX_HOME/generated_images and report its savedPath.
async function fakeCodex() {
  const { appendFileSync, copyFileSync, mkdirSync } = await import('node:fs');
  const { join } = await import('node:path');
  const { createInterface } = await import('node:readline');
  const argv = process.argv.slice(2);
  const log = (item) => appendFileSync(process.env.OCTOPUS_TEST_LOG, JSON.stringify(item) + '\n');
  const out = (item) => process.stdout.write(JSON.stringify(item) + '\n');
  if (argv.includes('--version')) { console.log('codex-cli 0.162.0 (fixture)'); return; }
  if (argv[0] === 'login') { console.log('Logged in using ChatGPT (synthetic fixture)'); return; }
  log({ kind: 'launch', argv, cwd: process.cwd() });
  let n = 0;
  for await (const line of createInterface({ input: process.stdin })) {
    let m; try { m = JSON.parse(line); } catch { continue; }
    if (m.id == null || !m.method) continue;
    let result = {};
    if (/^thread\/(start|resume)$/.test(m.method)) {
      log({ kind: 'thread', cwd: m.params.cwd, approvalPolicy: m.params.approvalPolicy, sandbox: m.params.sandbox, prompt: m.params.developerInstructions, config: m.params.config });
      result = { thread: { id: `fixture-thread-${process.pid}` }, model: 'fixture-image-model' };
    }
    out({ id: m.id, result });
    if (m.method !== 'turn/start') continue;
    const text = m.params.input.filter((i) => i.type === 'text').map((i) => i.text).join('\n');
    const images = m.params.input.filter((i) => i.type === 'localImage').map((i) => i.path);
    log({ kind: 'turn', text, images });
    const turn = `t${++n}`;
    out({ method: 'turn/started', params: { turn: { id: turn } } });
    const image = (src, extra = {}) => {
      const id = `ig_${n}`, dir = join(process.env.CODEX_HOME, 'generated_images');
      mkdirSync(dir, { recursive: true });
      const savedPath = src ? join(dir, `${id}.png`) : null;
      if (src) copyFileSync(src, savedPath);
      out({ method: 'item/started', params: { item: { type: 'imageGeneration', id, status: 'generating', revisedPrompt: null, result: '' } } });
      out({ method: 'item/completed', params: { item: { type: 'imageGeneration', id, status: src ? 'completed' : 'failed', revisedPrompt: 'Six bold ideas (revised)', result: '', ...(savedPath ? { savedPath } : {}), failure: null, ...extra } } });
    };
    if (text.includes('Generate 6 thumbnail ideas') && text.includes('LIMIT-TEST')) {
      image(null, { failure: { type: 'usageLimitExceeded', limitId: 'images', resetsAt: Math.floor(Date.now() / 1000) + 3600 } });
    } else if (text.includes('Generate 6 thumbnail ideas') && text.includes('NO-IMAGE-TEST')) {
      // A turn that ends without any image.
    } else if (text.includes('Generate 6 thumbnail ideas')) {
      image(process.env.OCTOPUS_TEST_SHEET);
      out({ method: 'item/completed', params: { item: { type: 'agentMessage', text: '1. BIG WIN — the result\n2. STOP — a warning\n3. HOW — steps\n4. 2X — speed\n5. WHY — question\n6. NEW — reveal' } } });
    } else if (text.includes('Refine')) {
      image(process.env.OCTOPUS_TEST_SQUARE);
      out({ method: 'item/completed', params: { item: { type: 'agentMessage', text: 'Refined.' } } });
    } else {
      out({ method: 'item/completed', params: { item: { type: 'agentMessage', text: 'Fixture reply.' } } });
    }
    out({ method: 'turn/completed', params: { turn: { id: turn, status: 'completed', durationMs: 1 } } });
  }
}

const freePort = () => new Promise((done, fail) => {
  const s = createServer();
  s.once('error', fail);
  s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => done(port)); });
});

async function startServer(t, { engine = 'claude' } = {}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'octopus-packaging-server-')));
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
  write(join(bin, 'codex.cmd'), 'unused npm shim fixture');
  write(join(bin, 'node_modules/@openai/codex/package.json'), JSON.stringify({ type: 'module', bin: 'fixture.mjs' }));
  write(join(bin, 'node_modules/@openai/codex/fixture.mjs'), `(${fakeCodex.toString()})().catch((e) => { console.error(e.stack); process.exitCode = 1; });\n`);
  const sheet = join(root, 'sheet.png'), square = join(root, 'square.png');
  writeFileSync(sheet, sheetPng(960, 640));
  writeFileSync(square, png(512, 512, (x, y) => [x % 256, y % 256, 128]));
  const shell = join(root, 'fixture-shell');
  write(shell, `#!${process.execPath}\nprocess.stdout.write('__P__' + process.env.PATH + '__P__');\n`);
  if (process.platform !== 'win32') execFileSync('chmod', ['700', shell]);
  const port = await freePort();
  write(join(local, 'settings.json'), JSON.stringify({
    studio, setup: { done: true, agent: '' }, updates: { auto: false }, scheduleCatchUp: false, permissionMode: 'auto', help: { stepsIntro: 'dismissed' },
    claude: { engine, lean: true, ccSource: 'plan', codexProvider: 'chatgpt', piSource: 'pi' }, codexPath: join(bin, 'codex.cmd'),
  }));
  write(join(local, 'schedules.json'), '{"v":1,"schedules":[]}');
  const LOG = join(root, 'wire.jsonl');
  writeFileSync(LOG, '');
  const env = {
    PATH: [bin, dirname(process.execPath), process.env.PATH].join(process.platform === 'win32' ? ';' : ':'),
    HOME: home, USERPROFILE: home, SHELL: shell, TMPDIR: root, TMP: root, TEMP: root, STUDIO_LOCAL_DIR: local, STUDIO_NO_OPEN: '1', STUDIO_NO_SCHEDULES: '1',
    CODEX_HOME: join(home, '.codex'), CLAUDE_CONFIG_DIR: join(home, '.claude'), HF_HUB_OFFLINE: '1', PORT: String(port), LC_ALL: 'C',
    OCTOPUS_TEST_LOG: LOG, OCTOPUS_TEST_SHEET: sheet, OCTOPUS_TEST_SQUARE: square,
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
  const req = async (path, data, { raw = null, headers = {} } = {}) => {
    const init = raw ? { method: 'POST', headers: { 'X-Studio': '1', ...headers }, body: raw }
      : data === undefined ? {} : { method: 'POST', headers: { 'X-Studio': '1', 'Content-Type': 'application/json' }, body: JSON.stringify(data) };
    const r = await fetch(url + path, init);
    const type = r.headers.get('content-type') || '';
    const body = type.startsWith('image/') ? Buffer.from(await r.arrayBuffer()) : await r.text().then((x) => { try { return JSON.parse(x); } catch { return x; } });
    return { status: r.status, body, type };
  };
  const ok = async (path, data, opts) => { const r = await req(path, data, opts); assert.equal(r.status, 200, `${path}: ${JSON.stringify(r.body)}\n${logs.slice(-2000)}`); return r.body; };
  for (let i = 0; i < 200; i++) {
    if (child.exitCode !== null) throw new Error(logs);
    try { if ((await fetch(`${url}/api/learning`)).ok) break; } catch {}
    await sleep(100);
  }
  const wire = () => readFileSync(LOG, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  // Wait until the board satisfies a condition (images are stored after the turn's item arrives).
  const until = async (path, check, what) => {
    let last = null;
    for (let i = 0; i < 200; i++) {
      last = await ok(path);
      if (check(last)) return last;
      await sleep(50);
    }
    const chatLogs = (() => { try { return readFileSync(join(local, 'chats', `${path.split('/')[3]}.packaging.jsonl`), 'utf8').slice(-3000); } catch { return ''; } })();
    throw new Error(`Timed out waiting for ${what}\n${JSON.stringify(last?.board?.sheets?.[0] || last).slice(0, 600)}\n${chatLogs}\n${logs.slice(-3000)}`);
  };
  return { root, studio, local, url, req, ok, wire, until, logs: () => logs };
}

test('Packaging end to end with a fake Codex: Generate → 6 cards, refine → 1280 × 720, board, uploads, title, limits', async (t) => {
  const s = await startServer(t, { engine: 'claude' });
  const A = await s.ok('/api/learning/profiles', { name: 'Alpha channel' });
  const B = await s.ok('/api/learning/profiles', { name: 'Beta channel' });
  const vid = (await s.ok('/api/projects', { name: 'Alpha video', type: 'tutorial', profileId: A.id })).id;
  const other = (await s.ok('/api/projects', { name: 'Beta video', type: 'tutorial', profileId: B.id })).id;
  const P = `/api/packaging/${vid}`;

  // The Package stage is first on the rail, optional, and not done yet; Record is still the next required step.
  let project = await s.ok(`/api/projects/${vid}`);
  assert.equal(project.pipeline.stages[0].name, 'Package');
  const pkgStep = project.pipeline.steps.find((x) => x.id === 'package');
  assert.equal(pkgStep.optional, true);
  assert.equal(pkgStep.done, false);
  assert.equal(project.pipeline.next, 'import', 'Package never blocks');

  // Resources at three levels, including "who is in it"; Beta's never reach the Alpha video.
  const upload = (scope, name, q = '') => s.ok(`/api/resources/upload?scope=${encodeURIComponent(scope)}&name=${encodeURIComponent(name)}${q}`, null, { raw: png(64, 64, () => [[...name].reduce((a, c) => a + c.charCodeAt(0), 0) % 256, name.length, 50]) });
  const me = await upload('global', 'me.png', '&kind=photo&likeness=self&use=always');
  const friend = await upload('global', 'friend.png', '&kind=photo&likeness=other&use=always');
  await upload(`profile:${A.id}`, 'alpha-logo.png', '&kind=logo&use=always');
  await upload(`profile:${B.id}`, 'beta-logo.png', '&kind=logo&use=always');
  await upload(`project:${vid}`, 'screenshot.png', '&kind=image');
  await upload(`project:${other}`, 'beta-shot.png', '&kind=image');
  assert.equal((await s.req(`/api/resources/upload?scope=global&name=x.png&kind=photo`, null, { raw: png(4, 4, () => [0, 0, 0]) })).status, 400, 'a photo must say who is in it');
  let view = await s.ok(P);
  assert.deepEqual(view.resources.map((l) => l.label), ['All styles', 'Brand kit: Alpha channel', 'This video']);
  const names = view.resources.flatMap((l) => l.items.map((r) => r.name)).sort();
  assert.deepEqual(names, ['alpha-logo.png', 'friend.png', 'me.png', 'screenshot.png']);
  assert.equal(view.resources[0].items.find((r) => r.name === 'friend.png').attachable, false);
  assert.equal(view.status.available, true, view.status.reason);
  const brandTab = await s.ok(`/api/resources?profile=${A.id}`);
  assert.deepEqual(brandTab.levels.map((l) => l.level), ['global', 'profile', 'project']);
  assert.deepEqual(brandTab.levels[2].videos.map((v) => v.id), [vid], 'the Brand tab lists only this channel’s videos');
  const studioRoot = s.studio;
  const resourcesMd = readFileSync(join(studioRoot, 'projects', vid, 'packaging/RESOURCES.md'), 'utf8');
  assert.match(resourcesMd, /me\.png[\s\S]*who is in it: Me/);
  assert.match(resourcesMd, /friend\.png[\s\S]*never send this picture/);
  assert.match(resourcesMd, /friend\.png[^\n]*kept in Video Octopus only/);
  assert.ok(!readdirSync(join(studioRoot, 'projects', vid, 'packaging/resources/all-channels')).some((n) => n.includes('friend')), 'someone else’s photo is not copied where an agent could use it');
  assert.doesNotMatch(resourcesMd, /beta/i);

  // Generate: one Codex turn (Codex even though the main engine is Claude Code), one image, cut into six cards.
  const gen = await s.ok(`${P}/generate`, { brief: 'editing faster' });
  assert.equal(gen.sheet.status, 'running');
  view = await s.until(P, (b) => b.board.items.length === 6 && b.board.sheets[0]?.status === 'done' && !b.busy, 'six cards');
  const turn = s.wire().filter((w) => w.kind === 'turn').at(-1);
  assert.match(turn.text, /Generate 6 thumbnail ideas for editing faster as ONE image/);
  assert.match(turn.text, /3 × 2 grid/);
  assert.equal(turn.images.length, 2, 'the creator’s own photo and the channel logo are attached; someone else’s photo is not');
  assert.ok(!turn.images.some((p) => p.includes(friend.hash)));
  const thread = s.wire().find((w) => w.kind === 'thread');
  assert.equal(thread.cwd, join(studioRoot, 'projects', vid), 'the Packaging chat runs in the project folder');
  assert.equal(thread.sandbox, 'read-only');
  assert.match(thread.prompt, /Packaging chat inside Video Octopus/);
  // Only the studio's context reaches the thread: no personal Codex hooks or memories, MCP servers, plugins or web search.
  assert.equal(thread.config?.['features.hooks'], false);
  assert.equal(thread.config?.['features.memories'], false);
  assert.equal(thread.config?.['features.plugins'], false);
  assert.equal(thread.config?.web_search, 'disabled');
  const sheet = view.board.sheets[0];
  assert.deepEqual(sheet.size, { width: 960, height: 640 });
  assert.deepEqual(sheet.wire, { status: 'completed', savedPath: true, resultChars: 0, transparentBackground: null }, 'what Codex sent is recorded (no bytes)');
  assert.equal(sheet.boxes.length, 6);
  const cards = view.board.items;
  assert.ok(cards.every((c) => c.origin === 'sheet-cell' && c.sheet === sheet.id));
  // Named from the reply's numbered lines once the turn ended.
  view = await s.until(P, (b) => b.board.items.some((x) => /BIG WIN/.test(x.name)), 'idea names');
  const first = view.board.items.find((x) => x.cell === 1);
  assert.match(first.name, /Idea 1 · BIG WIN/);
  const img = await s.req(`${P}/item/${first.id}`);
  assert.equal(img.type, 'image/png');
  const cellSize = pngSize(img.body);
  assert.ok(Math.abs(cellSize.width / cellSize.height - 16 / 9) < 0.03);
  // The chat log keeps the images event, so the chat shows the cards after a reload.
  const chatLog = readFileSync(join(s.local, 'chats', `${vid}.packaging.jsonl`), 'utf8');
  assert.match(chatLog, /"t":"images"/);

  // Refine #1: one 1280 × 720 child card.
  await s.ok(`${P}/items/${first.id}/refine`, { note: 'bigger text' });
  view = await s.until(P, (b) => b.board.items.some((x) => x.origin === 'refined') && !b.busy, 'the refined card');
  const refined = view.board.items.find((x) => x.origin === 'refined');
  assert.equal(refined.parent, first.id);
  assert.deepEqual(refined.size, { width: 1280, height: 720 });
  assert.deepEqual(pngSize((await s.req(`${P}/item/${refined.id}`)).body), { width: 1280, height: 720 });
  const refineTurn = s.wire().filter((w) => w.kind === 'turn').at(-1);
  assert.match(refineTurn.text, /bigger text/);
  assert.equal(refineTurn.images.length, 1, 'the card itself is attached');

  // Board: star, winners up to 3, main.
  await s.ok(`${P}/items/${cards[1].id}`, { star: true });
  for (const c of [refined, cards[1], cards[2]]) await s.ok(`${P}/items/${c.id}`, { winner: true });
  const fourth = await s.req(`${P}/items/${cards[3].id}`, { winner: true });
  assert.equal(fourth.status, 400);
  assert.match(fourth.body.error, /Up to 3 winners/);
  assert.equal((await s.ok(`${P}/items/${refined.id}`, { main: true })).main, refined.id);
  project = await s.ok(`/api/projects/${vid}`);
  assert.equal(project.pipeline.steps.find((x) => x.id === 'package').done, true, 'a main thumbnail finishes Package');
  assert.equal(project.pipeline.stages[0].done, true);
  const packagingMd = readFileSync(join(studioRoot, 'projects', vid, 'packaging/PACKAGING.md'), 'utf8');
  assert.match(packagingMd, /Main thumbnail: thumbnails\/main\.png/);
  assert.ok(existsSync(join(studioRoot, 'projects', vid, 'packaging/thumbnails/main.png')));

  // An old thumbnail.
  const old = await s.ok(`${P}/upload?name=last-year.png`, null, { raw: png(320, 180, () => [10, 20, 30]) });
  assert.equal(old.origin, 'uploaded');
  assert.equal(old.status, 'old');
  assert.equal((await s.req(`${P}/upload?name=notes.txt`, null, { raw: Buffer.from('not an image') })).status, 400);

  // Title: fills an empty Post title, never overwrites.
  assert.equal((await s.ok(`${P}/title`, { title: 'Edit twice as fast' })).post, 'later');
  write(join(studioRoot, 'projects', vid, 'work/post.json'), JSON.stringify({ youtube: { title: '' } }));
  assert.equal((await s.ok(`${P}/title`, { title: 'Edit twice as fast' })).post, 'filled');
  assert.equal((await s.ok(`${P}/title`, { title: 'Something else' })).post, 'kept');
  assert.equal(JSON.parse(readFileSync(join(studioRoot, 'projects', vid, 'work/post.json'), 'utf8')).youtube.title, 'Edit twice as fast');

  // Usage limit: the sheet fails with the reset time, and the chat says so.
  await s.ok(`${P}/generate`, { brief: 'LIMIT-TEST' });
  view = await s.until(P, (b) => b.board.sheets[0]?.status === 'failed' && !b.busy, 'the failed sheet');
  assert.equal(view.board.sheets[0].failure.kind, 'usage-limit');
  assert.match(view.board.sheets[0].failure.message, /Image limit reached on your ChatGPT plan\. It resets at/);
  assert.match(readFileSync(join(s.local, 'chats', `${vid}.packaging.jsonl`), 'utf8'), /Image limit reached/);
  // A turn that brings no image fails its sheet instead of leaving it running.
  await s.ok(`${P}/generate`, { brief: 'NO-IMAGE-TEST' });
  view = await s.until(P, (b) => b.board.sheets[0]?.status === 'failed' && !b.busy, 'the empty sheet');
  assert.match(view.board.sheets[0].failure.message, /without an image/);

  // The images are referenced: the Storage page's unused report doesn't offer them for deletion.
  const report = await s.ok('/api/learning/files');
  assert.equal(report.unused.length, 0);
});

test('Packaging says why it cannot draw when Codex is not on a ChatGPT plan', async (t) => {
  const s = await startServer(t, { engine: 'claude' });
  const vid = (await s.ok('/api/projects', { name: 'Plain video', type: 'short' })).id;
  // Replace the file in one step (write, then rename), as the app does: the running server may read it at any moment.
  const settingsFile = join(s.local, 'settings.json');
  write(`${settingsFile}.tmp`, JSON.stringify({ ...JSON.parse(readFileSync(settingsFile, 'utf8')), claude: { engine: 'claude', codexProvider: 'ollama' } }));
  renameSync(`${settingsFile}.tmp`, settingsFile);
  await sleep(300);
  const view = await s.ok(`/api/packaging/${vid}`);
  assert.equal(view.status.available, false);
  assert.match(view.status.reason, /local model/);
  const refused = await s.req(`/api/packaging/${vid}/generate`, {});
  assert.equal(refused.status, 409);
  assert.deepEqual(view.resources.map((l) => l.label), ['All styles', 'This video'], 'a video without a channel has two levels');
});
