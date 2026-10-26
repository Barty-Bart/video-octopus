// Simple mode's profiles (server/simple-profiles.mjs, web/profile-kinds.js): one folder per kind of video, each with
// its own files, instructions and learnings. The pure rules first; then on a real server in a disposable app and studio
// copy, with a fake agent that never calls a model or the network: make a profile, its folder and files (upload,
// remove, Undo), a topic video that starts with its research brief and the profile in its chat's context, a lesson
// Claude saves going into LEARNINGS.md once, and a batch with references split into one video per script.
//   node --test test/simple-profiles.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawn, execFileSync } from 'node:child_process';
import { createServer } from 'node:net';
import { profileSlug, cleanFileName, lessonsOf, splitPlan, profileLine } from '../web/profile-kinds.js';
import { SHAPES } from '../web/simple.js';

const APP = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const write = (path, value) => { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, value); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const lf = (s) => String(s).replace(/\r\n/g, '\n');

test('profile kinds: folder names, file names, lessons and split plans', () => {
  assert.equal(profileSlug('Main YouTube!'), 'main-youtube');
  assert.equal(profileSlug('  Insta  batch '), 'insta-batch');
  assert.equal(cleanFileName('../../etc/passwd'), 'passwd');
  assert.equal(cleanFileName('.env'), '', 'no dot files');
  assert.equal(cleanFileName('a<b>.png'), 'ab.png');
  assert.deepEqual(lessonsOf({ lessons: [{ text: '  Short   hooks ', stage: 'script' }, { text: '' }, 'Plain'] }), [{ text: 'Short hooks', stage: 'script' }, { text: 'Plain', stage: '' }]);
  assert.deepEqual(lessonsOf(null), []);
  assert.match(splitPlan(null).error, /marked/);
  assert.match(splitPlan({ videos: [{ start: 0, end: 0.5 }] }).error, /usable/);
  assert.match(splitPlan({ videos: [{ start: 0, end: 5 }, { start: 3, end: 8 }] }).error, /starts before/);
  assert.match(splitPlan({ videos: [{ start: 0, end: 50 }] }, 10).error, /after the take/);
  assert.deepEqual(splitPlan({ videos: [{ title: ' One ', start: 0, end: 4, script: 'a' }, { start: 4, end: 9 }] }, 10).videos,
    [{ title: 'One', start: 0, end: 4, script: 'a' }, { title: 'Video 2', start: 4, end: 9, script: '' }]);
  assert.equal(profileLine({ workflow: 'topic', shape: 'youtube', script: 'full' }, SHAPES), 'Topic → video · YouTube · Full script');
  assert.equal(profileLine({ workflow: 'batch', shape: 'reel', script: 'full' }, SHAPES), 'Batch of shorts · Reel');
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
    if (text.includes('LEARN-FIXTURE')) {
      mkdirSync(join(process.cwd(), 'work'), { recursive: true });
      writeFileSync(join(process.cwd(), 'work', 'learnings.json'), JSON.stringify({ lessons: [{ text: 'Open with the result, not the setup.', stage: 'script' }] }));
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
  const root = mkdtempSync(join(realpathSync(tmpdir()), 'octopus-profiles-'));
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


const hasFfmpeg = (() => { try { execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' }); return true; } catch { return false; } })();

test('server: profiles are folders with their own files; a topic video researches first and learns', async (t) => {
  const s = await startServer(t);
  assert.deepEqual((await s.ok('/api/simple-profiles')).profiles, []);
  const p = await s.ok('/api/simple-profiles', { name: 'Main channel', workflow: 'topic', shape: 'youtube', script: 'points' });
  assert.equal(p.slug, 'main-channel');
  const dir = join(s.studio, 'profiles', 'main-channel');
  for (const f of ['profile.json', 'INSTRUCTIONS.md', 'LEARNINGS.md', 'skills/README.md']) assert.ok(existsSync(join(dir, f)), f);
  assert.equal((await s.ok('/api/simple-profiles', { name: 'Main channel', workflow: 'topic' })).slug, 'main-channel-2', 'a second one of the same name gets its own folder');
  assert.equal((await s.req('/api/simple-profiles', { name: ' ' })).status, 400);

  // The four kinds, the look and lessons by hand.
  const shorts = await s.ok('/api/simple-profiles', { name: 'Shorts', preset: 'shorts-batch' });
  assert.deepEqual([shorts.workflow, shorts.shape], ['batch', 'reel']);
  assert.equal((await s.req('/api/simple-profiles', { name: 'X', preset: 'nope' })).status, 400);
  const looked = await s.ok('/api/simple-profiles/shorts', { look: { colors: ['#EA580C', 'red', '#ea580c', '#111111'], font: 'Inter', voice: 'Dry' } });
  assert.deepEqual(looked.look, { colors: ['#ea580c', '#111111'], font: 'Inter', voice: 'Dry' });
  let withLesson = await s.ok('/api/simple-profiles/shorts/lessons', { add: 'Hook in the first 3 seconds' });
  assert.deepEqual(withLesson.lessons.map((l) => l.text), ['Hook in the first 3 seconds']);
  withLesson = await s.ok('/api/simple-profiles/shorts/lessons', { remove: 'Hook in the first 3 seconds' });
  assert.deepEqual(withLesson.lessons, []);
  await s.ok('/api/simple-profiles/shorts/delete', {});
  assert.ok(!existsSync(join(s.studio, 'profiles', 'shorts')) && readdirSync(join(s.studio, 'profiles', '.removed')).some((n) => n.endsWith('-shorts')), 'removed, never deleted');

  // Files: upload, remove, Undo.
  const up = await s.ok('/api/simple-profiles/main-channel/upload?name=logo.png', undefined, Buffer.from('fixture'));
  assert.equal(up.name, 'logo.png');
  assert.equal((await s.ok('/api/simple-profiles/main-channel/upload?name=logo.png', undefined, Buffer.from('two'))).name, 'logo (2).png');
  const gone = await s.ok('/api/simple-profiles/main-channel/remove', { name: 'logo.png' });
  assert.equal((await s.ok('/api/simple-profiles/main-channel')).fileList.map((f) => f.name).join(), 'logo (2).png');
  await s.ok('/api/simple-profiles/main-channel/restore', { removed: gone.removed });
  assert.equal((await s.ok('/api/simple-profiles/main-channel')).files, 2);
  assert.equal((await s.req('/api/simple-profiles/main-channel/file/..%2Fprofile.json')).status, 404);
  const saved = await s.ok('/api/simple-profiles/main-channel', { instructions: '# Main\nTalk like a friend.', look: { colors: ['#2563eb'] } });
  assert.match(saved.instructions, /Talk like a friend/);

  // A topic video: the research brief is its first message, and the profile is in its chat's context.
  const { id } = await s.ok('/api/simple-profiles/main-channel/start', { topic: 'Why local AI is getting faster' });
  assert.equal(s.meta(id).simpleProfile, 'main-channel');
  assert.equal(s.meta(id).name, 'Why local AI is getting faster');
  const first = await s.until(() => s.agentLog().find((e) => e.kind === 'message' && e.text.includes('Why local AI')), 'the research brief');
  assert.match(first.text, /work\/research\.md/);
  assert.match(first.text, /talking points/);
  const launch = s.agentLog().find((e) => e.kind === 'launch');
  assert.ok(launch.prompt.includes(join(s.studio, 'profiles', 'main-channel').replaceAll('\\', '\\')) || launch.prompt.includes('profiles'), 'the chat is told where the profile folder is');
  assert.match(launch.prompt, /LEARNINGS\.md/);
  assert.match(launch.prompt, /colours #2563eb/, 'the profile’s look reaches the chat');
  assert.equal((await s.ok('/api/projects')).find((x) => x.id === id).profile, 'main-channel');

  // A lesson Claude saves goes into the profile's LEARNINGS.md once, with a line in the chat.
  await s.ok(`/api/projects/${id}/chat`, { text: 'LEARN-FIXTURE: open with the result' });
  await s.until(() => lf(readFileSync(join(dir, 'LEARNINGS.md'), 'utf8')).includes('Open with the result'), 'the lesson in LEARNINGS.md');
  await s.ok(`/api/projects/${id}/chat`, { text: 'LEARN-FIXTURE again' });
  await s.until(() => s.agentLog().filter((e) => e.kind === 'message' && e.text.includes('LEARN-FIXTURE again')).length, 'the second message');
  await sleep(600);
  const learned = lf(readFileSync(join(dir, 'LEARNINGS.md'), 'utf8')).split('\n').filter((l) => l.includes('Open with the result'));
  assert.equal(learned.length, 1, 'never copied twice');
  assert.equal((await s.ok('/api/simple-profiles/main-channel')).learnings, 1);
});

test('server: a batch takes references, then splits one take into one video per script', { skip: !hasFfmpeg && 'needs ffmpeg' }, async (t) => {
  const s = await startServer(t);
  await s.ok('/api/simple-profiles', { name: 'Instagram', workflow: 'batch' });
  const { id } = await s.ok('/api/simple-profiles/instagram/start', { topic: 'Three AI tools' });
  assert.equal(s.meta(id).batch, true);
  assert.equal(s.agentLog().filter((e) => e.kind === 'message').length, 0, 'a batch waits for its references');
  await s.ok(`/api/simple-profiles/ref?project=${id}&name=competitor.mp4`, undefined, Buffer.from('fixture'));
  assert.ok(existsSync(join(s.project(id), 'references', 'competitor.mp4')));
  assert.ok(!existsSync(join(s.project(id), 'source', 'competitor.mp4')), 'references are never the take');
  await s.ok(`/api/simple-profiles/kickoff/${id}`, {});
  const brief = await s.until(() => s.agentLog().find((e) => e.kind === 'message' && e.text.includes('New batch')), 'the batch brief');
  assert.match(brief.text, /competitor\.mp4/);
  assert.match(brief.text, /## <n>\. <title>/);
  assert.deepEqual(await s.ok(`/api/simple-profiles/split-state/${id}`), { take: false, ready: false, count: 0, split: [] });

  // A 6-second take (camera + mic) and Claude's split plan.
  const take = join(s.project(id), 'source', '2026-10-26_10-00-00_webcam.mp4');
  execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc=size=320x240:rate=30', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000',
    '-t', '6', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', take]);
  write(join(s.project(id), 'work', 'batch-split.json'), JSON.stringify({ videos: [
    { title: 'Tool one', start: 0.2, end: 2.8, script: '## 1. Tool one\nSay it.' }, { title: 'Tool two', start: 3, end: 5.8 }] }));
  assert.equal((await s.ok(`/api/simple-profiles/split-state/${id}`)).ready, true);
  const { videos } = await s.ok(`/api/simple-profiles/split/${id}`, {});
  assert.equal(videos.length, 2);
  for (const v of videos) {
    assert.equal(s.meta(v).simpleProfile, 'instagram');
    assert.equal(s.meta(v).batchOf, id);
    assert.ok(!s.meta(v).batch, 'a split video is an ordinary video');
    const files = readdirSync(join(s.project(v), 'source'));
    assert.deepEqual(files, ['2026-10-26_10-00-00_webcam.mp4']);
    const d = Number(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', join(s.project(v), 'source', files[0])]));
    assert.ok(d > 2.4 && d < 3.1, `about 2.7 s, got ${d}`);
  }
  assert.equal(s.meta(videos[0]).name, 'Tool one');
  assert.match(readFileSync(join(s.project(videos[0]), 'script.md'), 'utf8'), /Tool one/);
  assert.deepEqual(s.meta(id).split, videos);
  assert.equal((await s.req(`/api/simple-profiles/split/${id}`, {})).status, 400, 'a batch splits once');
});
