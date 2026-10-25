// An agent CLI that quits at once (installed but not signed in) or mid-turn must never take the server down, and the
// chat says what happened with Send again. Permission requests show paths from the project's folder, with a diff.
//   node --test test/agent-exit.test.mjs
// Disposable studio, HOME and settings; a stand-in CLI that exits at once. No real agent, model, key or network.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const APP = fileURLToPath(new URL('..', import.meta.url));
const root = mkdtempSync(join(realpathSync(tmpdir()), 'octopus-agent-exit-'));
const local = join(root, 'local'), studio = join(root, 'studio'), home = join(root, 'home'), bin = join(root, 'bin');
for (const d of [local, studio, home, bin]) mkdirSync(d, { recursive: true });
process.env.STUDIO_LOCAL_DIR = join(root, 'unit-local');
test.after(() => rmSync(root, { recursive: true, force: true }));

const freePort = () => new Promise((done, fail) => {
  const s = createServer().once('error', fail).listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => done(port)); });
});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// The fake CLI and login shell here are POSIX scripts; the EPIPE guard itself is the same code on Windows.
test('a Claude Code that quits at once: the server stays up, the chat says to sign in, Send again works', { timeout: 60000, skip: process.platform === 'win32' && 'POSIX fake CLI' }, async (t) => {
  // The stand-in: answers --version and `auth status` (not signed in), closes its input unread and quits.
  const fake = join(bin, 'claude');
  writeFileSync(fake, `#!${process.execPath}
const a = process.argv.slice(2);
if (a.includes('--version')) { console.log('9.9.9 (Claude Code)'); process.exit(0); }
if (a[0] === 'auth') { console.log(JSON.stringify({ loggedIn: false })); process.exit(0); }
process.stdin.destroy();
process.stderr.write('Not logged in · Please run /login\\n');
setTimeout(() => process.exit(1), 400);
`);
  chmodSync(fake, 0o755);
  const shell = join(bin, 'fixture-shell');
  writeFileSync(shell, `#!/bin/sh\nprintf '__P__%s__P__' '${bin}:/usr/bin:/bin'\n`);
  chmodSync(shell, 0o755);
  writeFileSync(join(local, 'settings.json'), JSON.stringify({ studio, setup: { done: true, agent: 'claude' }, updates: { auto: false }, scheduleCatchUp: false,
    claudePath: fake, permissionMode: 'manual', claude: { engine: 'claude', lean: true, useApiKey: false } }));
  const port = await freePort();
  const env = { PATH: `${bin}:/usr/bin:/bin`, HOME: home, USERPROFILE: home, TMPDIR: root, SHELL: shell, PORT: String(port), STUDIO_LOCAL_DIR: local,
    STUDIO_NO_SCHEDULES: '1', STUDIO_NO_OPEN: '1', XDG_DATA_HOME: join(home, '.local', 'share'), CLAUDE_CONFIG_DIR: join(home, '.claude') };
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
    await sleep(100);
  }
  const post = async (path, data) => {
    const r = await fetch(url + path, { method: 'POST', headers: { 'X-Studio': '1', 'Content-Type': 'application/json' }, body: JSON.stringify(data) });
    return { status: r.status, json: await r.json().catch(() => ({})) };
  };
  const log = join(local, 'chats', '_studio.jsonl');
  const errors = () => (existsSync(log) ? readFileSync(log, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)).filter((e) => e.t === 'error') : []);
  const until = async (what, fn) => { for (let i = 0; i < 100; i++) { if (child.exitCode !== null) assert.fail(`The server crashed (${what}):\n${logs}`); const v = fn(); if (v) return v; await sleep(100); } assert.fail(`${what}:\n${logs}`); };

  // A long message stays in the pipe while the CLI closes its end: the write fails with EPIPE (the crash in the walkthrough).
  await post('/api/projects/_studio/chat', { text: `Hello ${'x'.repeat(300000)}` });
  const first = await until('the chat says what happened', () => errors()[0]);
  assert.match(first.text, /^Claude Code isn't signed in\. Open Terminal and run claude, then Send again\.$/);
  assert.equal(first.retry, true);
  await sleep(500);
  assert.equal(child.exitCode, null, `the server is still running:\n${logs}`);
  assert.equal((await fetch(`${url}/api/app/counts`)).status, 200);
  assert.doesNotMatch(logs, /EPIPE|Uncaught|unhandled/i);

  // Send again: the same message goes again (no second copy in the chat), and the server still stays up.
  const again = await post('/api/projects/_studio/chat', { retry: true });
  assert.equal(again.status, 200, JSON.stringify(again.json));
  await until('Send again reports it too', () => errors().length >= 2);
  const users = readFileSync(log, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)).filter((e) => e.t === 'user');
  assert.equal(users.length, 1, 'Send again does not repeat the message in the chat');
  await sleep(300);
  assert.equal(child.exitCode, null, `the server is still running:\n${logs}`);
});

test('the stopped message: signed out, quit at once, crashed mid-turn', async () => {
  const { stoppedEvent } = await import('../server/claude.mjs');
  assert.deepEqual(stoppedEvent('Claude Code', 1, '', { early: true, signedOut: true, signIn: 'claude' }),
    { t: 'error', kind: 'signed-out', retry: true, text: "Claude Code isn't signed in. Open Terminal and run claude, then Send again." });
  assert.equal(stoppedEvent('Codex', 1, 'Error: Not logged in. Run codex login.', { signIn: 'codex login' }).kind, 'signed-out');
  const early = stoppedEvent('pi', 2, 'boom\nno models configured', { early: true });
  assert.equal(early.kind, 'start');
  assert.match(early.text, /^pi stopped as soon as it started \(exit 2\): boom no models configured\. Check that it runs in Terminal, then Send again\.$/);
  const crash = stoppedEvent('Claude Code', 3, 'Error: synthetic failure: the agent process crashed\n', { early: false, signedOut: false, signIn: 'claude' });
  assert.deepEqual(crash, { t: 'error', kind: 'stopped', retry: true, text: 'Claude Code stopped (exit 3). Error: synthetic failure: the agent process crashed' });
});

test('a permission request shows the file from the project folder (or ~/), a small diff, and never an empty box', async () => {
  const { permissionView, shownPath } = await import('../server/claude.mjs');
  const project = join(root, 'studio', 'projects', 'demo');
  mkdirSync(join(project, 'work'), { recursive: true });
  assert.equal(shownPath(join(project, 'WORKLOG.md'), project), 'WORKLOG.md');
  assert.equal(shownPath('work/blocks.json', project), 'work/blocks.json');
  // macOS: /tmp and /private/tmp are the same place.
  if (process.platform === 'darwin' && project.startsWith('/private/')) assert.equal(shownPath(project.replace(/^\/private/, '') + '/work/x.json', project), 'work/x.json');
  assert.equal(shownPath(join(homedir(), 'Movies', 'take.mov'), project), '~/Movies/take.mov');
  assert.equal(shownPath('/etc/hosts', project), '/etc/hosts');

  const edit = permissionView('Edit', { file_path: join(project, 'WORKLOG.md'), old_string: 'a\nb', new_string: 'a\nc' }, project);
  assert.deepEqual(edit, { file: 'WORKLOG.md', diff: '- a\n- b\n+ a\n+ c' });
  // An Edit that only notes the file (no strings): the file, and no empty diff.
  assert.deepEqual(permissionView('Edit', { file_path: join(project, 'WORKLOG.md') }, project), { file: 'WORKLOG.md' });
  assert.deepEqual(permissionView('Write', { file_path: join(project, 'work/plan.json'), content: '' }, project), { file: 'work/plan.json' });
  assert.equal(permissionView('Write', { file_path: join(project, 'n.md'), content: 'one\ntwo' }, project).detail, 'one\ntwo');
  assert.deepEqual(permissionView('Bash', { command: 'npm test', description: 'Run the tests' }, project), { detail: 'npm test' });
  // Other tools: plain lines, not JSON.
  assert.deepEqual(permissionView('WebFetch', { url: 'https://example.com', prompt: 'Read it', description: 'x' }, project), { detail: 'url: https://example.com\nprompt: Read it' });
  assert.deepEqual(permissionView('Mystery', {}, project), {});
});

test('Codex: file-change requests show project paths and their diff; a usage-limit turn ends "limit"', async () => {
  const { CodexSession } = await import('../server/codex.mjs');
  const project = join(root, 'studio', 'projects', 'demo');
  const c = new CodexSession('unit-codex', () => '');
  c.guard = () => project;
  const ev = [];
  c.emit = (e) => ev.push(e);
  c.write = () => true;
  const f = join(project, 'work', 'notes.md');
  c.handle({ method: 'item/started', params: { item: { type: 'fileChange', id: 'fc1', changes: [{ path: f, kind: { type: 'update' }, diff: '--- a\n+++ b\n@@ -1 +1 @@\n-old\n+new' }] } } });
  c.handle({ id: 9, method: 'item/fileChange/requestApproval', params: { itemId: 'fc1' } });
  const card = ev.find((e) => e.t === 'permission');
  assert.equal(card.file, 'work/notes.md');
  assert.equal(card.diff, '@@ -1 +1 @@\n-old\n+new');
  assert.equal(card.detail, undefined);
  c.handle({ method: 'item/completed', params: { item: { type: 'fileChange', id: 'fc1', status: 'completed', changes: [{ path: f, kind: { type: 'update' } }] } } });
  assert.equal(ev.find((e) => e.t === 'tool_result').text, 'update work/notes.md');
  // The image hit the plan's limit: the turn still completes, and the chat says it stopped on the limit.
  c.imageDone({ type: 'imageGeneration', id: 'ig', status: 'failed', failure: { type: 'usageLimitExceeded', resetsAt: Math.floor(Date.now() / 1000) + 3600 } });
  c.handle({ method: 'turn/completed', params: { turn: { status: 'completed', durationMs: 1000 } } });
  assert.equal(ev.find((e) => e.t === 'result').why, 'limit');
  ev.length = 0;
  c.handle({ method: 'turn/completed', params: { turn: { status: 'completed', durationMs: 1000 } } });
  assert.equal(ev.find((e) => e.t === 'result').why, undefined, 'the next turn is not marked');
});

test('Send again re-sends the last message or brief once, and says so', async () => {
  const { ChatSession } = await import('../server/claude.mjs');
  const c = new ChatSession('unit-retry', () => '');
  const sent = [], ev = [];
  c.emit = (e) => ev.push(e);
  c.send = async (text, opts) => { sent.push([text, opts]); };
  await assert.rejects(() => c.retry(), /Nothing to send again/);
  c.lastSend = 'Build the intro brief';
  c.lastBrief = { step: 'intro', name: 'Build the intro' };
  await c.retry();
  assert.deepEqual(sent, [['Build the intro brief', { echo: false, brief: { step: 'intro', name: 'Build the intro' } }]]);
  assert.deepEqual(ev.map((e) => [e.t, e.text, e.brief?.step]), [['note', 'Sent again.', undefined], ['turn', 'Build the intro brief', 'intro']], 'the step is tracked again (Didn’t finish)');
  c.busy = true;
  await assert.rejects(() => c.retry(), /is working/);
});
