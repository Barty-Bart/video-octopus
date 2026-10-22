// Request bodies and the app's own JSON files (server/util.mjs): multi-byte text split across network chunks, 413 and
// 400 instead of an empty save, atomic writes, and a broken settings file kept aside instead of overwritten.
// Disposable temporary folders only; the one server this starts listens on a free localhost port with its own
// settings, home and studio folders.
//   node --test test/reliability.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import fs, { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { Readable } from 'node:stream';
import { spawn } from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const APP = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const root = mkdtempSync(join(tmpdir(), 'octopus-reliability-'));
const local = join(root, 'local');
process.env.STUDIO_LOCAL_DIR = local; // util.mjs reads it once, at import
const util = await import('../server/util.mjs');
test.after(() => rmSync(root, { recursive: true, force: true }));

// A request as readJSONBody sees it: the body arrives in these chunks.
const request = (chunks) => Readable.from(chunks.map((c) => Buffer.from(c)));
const folder = (name) => { const dir = join(root, name); mkdirSync(dir, { recursive: true }); return dir; };
const leftovers = (dir) => readdirSync(dir).filter((f) => f.endsWith('.tmp'));

// Make fs.renameSync fail (util.mjs imports it by name, so the ESM bindings are synced too) for one test.
function failRename(t, fail) {
  const real = fs.renameSync;
  let calls = 0;
  t.mock.method(fs, 'renameSync', (from, to) => { calls++; const e = fail(calls); if (e) throw e; return real(from, to); });
  syncBuiltinESMExports();
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  return () => calls;
}
const fsError = (code) => Object.assign(new Error(`${code}: synthetic`), { code });

// ---- request bodies ----

test('a multi-byte character split between two chunks is decoded whole', async () => {
  const text = 'Zażółć gęślą jaźń · “quotes” · 🐙';
  const bytes = Buffer.from(JSON.stringify({ text }));
  // Every split point, most of them inside a character's bytes.
  for (let at = 1; at < bytes.length; at++) {
    const b = await util.readJSONBody(request([bytes.subarray(0, at), bytes.subarray(at)]));
    assert.equal(b.text, text, `split at byte ${at}`);
  }
  // Byte by byte, too.
  const b = await util.readJSONBody(request([...bytes].map((x) => Buffer.from([x]))));
  assert.equal(b.text, text);
});

test('an empty body is {} and whitespace counts as empty', async () => {
  assert.deepEqual(await util.readJSONBody(request([])), {});
  assert.deepEqual(await util.readJSONBody(request([' \n'])), {});
});

test('a body over the limit is a 413 after the whole body was read, never a truncated parse', async () => {
  const big = JSON.stringify({ text: 'x'.repeat(2000) });
  const req = request([big.slice(0, 1000), big.slice(1000)]);
  await assert.rejects(util.readJSONBody(req, 1500), (e) => e.status === 413 && /too large/.test(e.message));
  assert.equal(req.readableEnded, true, 'the rest of the body is drained so the answer reaches the browser');
  // A route's own larger limit (exports, the library) still takes it.
  assert.equal((await util.readJSONBody(request([big]), 60e6)).text.length, 2000);
});

test('malformed JSON is a 400, not {}', async () => {
  await assert.rejects(util.readJSONBody(request(['{"text": "unfinished'])), (e) => e.status === 400 && /valid JSON/.test(e.message));
  await assert.rejects(util.readJSONBody(request(['not json'])), (e) => e.status === 400);
});

// ---- atomic writes ----

test('writeJSON replaces the file in one rename and leaves no temporary file', () => {
  const dir = folder('atomic'), file = join(dir, 'state.json');
  util.writeJSON(file, { v: 1 });
  util.writeJSON(file, { v: 2, text: 'ż🐙' });
  assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), { v: 2, text: 'ż🐙' });
  assert.deepEqual(leftovers(dir), []);
});

test('a failed write leaves the old file intact and removes its temporary file', (t) => {
  const dir = folder('atomic-fail'), file = join(dir, 'settings.json');
  util.writeJSON(file, { keep: 'me' });
  const before = readFileSync(file, 'utf8');
  failRename(t, () => fsError('EIO'));
  assert.throws(() => util.writeJSON(file, { keep: 'not this' }), /EIO/);
  assert.equal(readFileSync(file, 'utf8'), before);
  assert.deepEqual(leftovers(dir), []);
  // Data that can't be written at all never touches the file either.
  assert.throws(() => util.writeJSON(file, { n: 1n }), /BigInt/);
  assert.equal(readFileSync(file, 'utf8'), before);
});

test('a file locked for a moment (Windows EBUSY) is replaced after a retry', (t) => {
  const dir = folder('atomic-retry'), file = join(dir, 'state.json');
  util.writeJSON(file, { v: 1 });
  const calls = failRename(t, (n) => (n <= 2 ? fsError('EBUSY') : null));
  util.writeJSON(file, { v: 2 });
  assert.equal(calls(), 3);
  assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), { v: 2 });
  assert.deepEqual(leftovers(dir), []);
});

test('a file that stays locked (Windows EPERM) is written in place instead of losing the save', (t) => {
  const dir = folder('atomic-locked'), file = join(dir, 'state.json');
  util.writeJSON(file, { v: 1 });
  const calls = failRename(t, () => fsError('EPERM'));
  util.writeJSON(file, { v: 2 });
  assert.ok(calls() >= 2, 'it tried the rename again first');
  assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), { v: 2 });
  assert.deepEqual(leftovers(dir), []);
});

// ---- the app's own JSON files ----

test('readOwnJSON: a missing file is the fallback and nothing is created', () => {
  const dir = folder('own-missing');
  assert.deepEqual(util.readOwnJSON(join(dir, 'schedules.json'), { schedules: [] }), { schedules: [] });
  assert.deepEqual(readdirSync(dir), []);
});

test('readOwnJSON: a broken file is moved aside with its bytes intact, with a warning', (t) => {
  const dir = folder('own-corrupt'), file = join(dir, 'layouts.json');
  const broken = '{"layouts": [{"id": "a", "name": "Half wri';
  writeFileSync(file, broken);
  const warn = t.mock.method(console, 'warn', () => {});
  assert.equal(util.readOwnJSON(file, null), null);
  const kept = readdirSync(dir).filter((f) => f.startsWith('layouts.json.corrupt-'));
  assert.equal(kept.length, 1);
  assert.equal(readFileSync(join(dir, kept[0]), 'utf8'), broken);
  assert.equal(existsSync(file), false);
  assert.match(String(warn.mock.calls[0].arguments[0]), /layouts\.json couldn't be read.*corrupt-/);
  // Valid JSON that isn't an object (null, a list) is broken for these files too; a second one doesn't overwrite the first.
  writeFileSync(file, '[1, 2]');
  util.readOwnJSON(file, null);
  assert.equal(readdirSync(dir).filter((f) => f.startsWith('layouts.json.corrupt-')).length, 2);
});

test('readJSON keeps its old meaning for project files: the fallback, and the file left alone', () => {
  const dir = folder('project'), file = join(dir, 'blocks.json');
  writeFileSync(file, '{"blocks": [');
  assert.equal(util.readJSON(file, 'fallback'), 'fallback');
  assert.equal(readFileSync(file, 'utf8'), '{"blocks": [');
});

test('a corrupt settings.json is kept as .corrupt-* and the next save does not overwrite it', (t) => {
  const file = join(local, 'settings.json');
  const broken = '{"studio": "/Users/someone/My studio", "claude": {"engine": "co';
  writeFileSync(file, broken);
  t.mock.method(console, 'warn', () => {});
  const s = util.settings();
  assert.equal(s.studio, '', 'the defaults while the file is broken');
  assert.equal(s.port, 4800);
  util.saveSettings({ model: 'chosen-after' });
  const kept = readdirSync(local).filter((f) => f.startsWith('settings.json.corrupt-'));
  assert.equal(kept.length, 1);
  assert.equal(readFileSync(join(local, kept[0]), 'utf8'), broken, 'the creator\'s old settings are still there to recover');
  assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), { model: 'chosen-after' });
  assert.equal(util.settings().model, 'chosen-after');
  rmSync(file);
  for (const f of kept) rmSync(join(local, f));
});

test('settings that cannot be read right now are never replaced by a save', { skip: process.platform === 'win32' || process.getuid?.() === 0 }, (t) => {
  const file = join(local, 'settings.json');
  writeFileSync(file, '{"studio": "/keep", "model": "mine"}');
  chmodSync(file, 0o000);
  t.after(() => { chmodSync(file, 0o644); rmSync(file); });
  t.mock.method(console, 'warn', () => {});
  assert.equal(util.settings().studio, '', 'reads fall back to the defaults instead of failing every request');
  assert.throws(() => util.saveSettings({ model: 'other' }), /EACCES/);
  chmodSync(file, 0o644);
  assert.equal(readFileSync(file, 'utf8'), '{"studio": "/keep", "model": "mine"}');
});

test('state.json: a broken file is kept aside and patching starts from an empty state', (t) => {
  const file = join(local, 'state.json');
  writeFileSync(file, '{"projects": {"a": {"sessionId": "x"');
  t.mock.method(console, 'warn', () => {});
  assert.deepEqual(util.state(), { projects: {} });
  util.setProjectState('b', { sessionId: 'y' });
  assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), { projects: { b: { sessionId: 'y' } } });
  assert.equal(readdirSync(local).filter((f) => f.startsWith('state.json.corrupt-')).length, 1);
});

// ---- the server's routes ----

const freePort = () => new Promise((done, fail) => {
  const s = createServer().once('error', fail).listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => done(port)); });
});

test('the server answers 413 and 400 through every kind of route and keeps multi-byte saves whole', async (t) => {
  const dir = folder('server'), home = join(dir, 'home'), studio = join(dir, 'studio'), own = join(dir, 'local');
  for (const p of [home, studio, own]) mkdirSync(p, { recursive: true });
  writeFileSync(join(own, 'settings.json'), JSON.stringify({ studio, setup: { done: true }, updates: { auto: false } }));
  const port = await freePort();
  const env = { ...process.env, PORT: String(port), STUDIO_LOCAL_DIR: own, STUDIO_NO_SCHEDULES: '1', HOME: home, USERPROFILE: home,
    LOCALAPPDATA: join(home, 'AppData', 'Local'), APPDATA: join(home, 'AppData', 'Roaming'), XDG_DATA_HOME: join(home, '.local', 'share'), TMPDIR: dir };
  const child = spawn(process.execPath, [join(APP, 'server', 'index.mjs')], { cwd: APP, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let logs = '';
  child.stdout.on('data', (b) => { logs += b; });
  child.stderr.on('data', (b) => { logs += b; });
  t.after(() => child.kill());
  const url = `http://127.0.0.1:${port}`;
  for (let i = 0; ; i++) {
    if (child.exitCode !== null) assert.fail(`The server stopped:\n${logs}`);
    try { await fetch(`${url}/api/app/counts`); break; } catch {}
    if (i > 150) assert.fail(`The server didn't start:\n${logs}`);
    await new Promise((r) => setTimeout(r, 100));
  }
  const post = async (path, text) => {
    const r = await fetch(url + path, { method: 'POST', headers: { 'X-Studio': '1', 'Content-Type': 'application/json' }, body: text });
    return { status: r.status, json: await r.json() };
  };
  const settingsBefore = readFileSync(join(own, 'settings.json'), 'utf8');
  // An inline route (the server's own catch), a route module with its own catch, and a minified one.
  for (const path of ['/api/settings', '/api/app/schedules', '/api/learning/profiles']) {
    const bad = await post(path, '{"model": "unfinished');
    assert.equal(bad.status, 400, `${path}: ${JSON.stringify(bad.json)}`);
    assert.match(bad.json.error, /valid JSON/);
    const big = await post(path, JSON.stringify({ model: 'x'.repeat(1.2e6) }));
    assert.equal(big.status, 413, `${path}: ${JSON.stringify(big.json)}`);
    assert.match(big.json.error, /too large/);
  }
  assert.equal(readFileSync(join(own, 'settings.json'), 'utf8'), settingsBefore, 'nothing was saved by a rejected body');
  // About 300 KB of Polish letters and emoji: TCP splits it into many chunks, nearly all of them mid-character.
  const model = 'Zażółć gęślą jaźń 🐙 '.repeat(12000);
  const ok = await post('/api/settings', JSON.stringify({ model }));
  assert.equal(ok.status, 200, JSON.stringify(ok.json));
  const saved = JSON.parse(readFileSync(join(own, 'settings.json'), 'utf8'));
  assert.equal(saved.model, model);
  assert.equal(saved.model.includes('�'), false);
  // An empty body is still {}: the save changes nothing and succeeds.
  const empty = await fetch(`${url}/api/settings`, { method: 'POST', headers: { 'X-Studio': '1' } });
  assert.equal(empty.status, 200);
  assert.equal(JSON.parse(readFileSync(join(own, 'settings.json'), 'utf8')).model, model);
});
