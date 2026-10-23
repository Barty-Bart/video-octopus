// Regression tests for the 23 October 2026 backend audit (handoff: backend-audit-2026-10-23), phase 2 of the hardening
// batch. Each test reproduces an audit receipt against a real server in a disposable app/studio copy, with fake Claude
// Code, Codex and pi CLIs that record what they were given. No real agent, model, credential or network is used.
//   node --test test/agent-scope.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync, appendFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawn, execFileSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { createServer } from 'node:net';

const APP = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const write = (path, value) => { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, value); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// The fake CLI, written into an npm-style package (so the Windows .cmd shim path is the one used everywhere). It records
// launches, skill roots and messages in OCTOPUS_TEST_LOG and answers with each adapter's wire shape.
async function fakeCLI() {
  const { appendFileSync, existsSync, readFileSync, readdirSync, writeFileSync, mkdirSync } = await import('node:fs');
  const { join, dirname } = await import('node:path');
  const { createInterface } = await import('node:readline');
  const engine = process.env.OCTOPUS_TEST_ENGINE, argv = process.argv.slice(2);
  const arg = (key) => (argv.includes(key) ? argv[argv.indexOf(key) + 1] : null);
  const log = (item) => appendFileSync(process.env.OCTOPUS_TEST_LOG, JSON.stringify({ engine, pid: process.pid, ...item }) + '\n');
  const out = (item) => process.stdout.write(JSON.stringify(item) + '\n');
  const names = (root) => (root && existsSync(root) ? readdirSync(root).filter((n) => existsSync(join(root, n, 'SKILL.md'))).sort() : null);
  if (argv.includes('--version')) { console.log('9.9.9 fixture'); return; }
  if (argv[0] === 'auth') { console.log('{"loggedIn":true,"authMethod":"claude.ai","subscriptionType":"fixture"}'); return; }
  if (argv[0] === 'login') { console.log('Logged in using ChatGPT (synthetic fixture)'); return; }
  const promptFile = engine === 'claude' ? arg('--append-system-prompt-file') : engine === 'pi' ? arg('--append-system-prompt') : null;
  let settingsJson = null;
  try { settingsJson = JSON.parse(arg('--settings')); } catch {}
  const addDir = arg('--add-dir');
  log({ kind: 'launch', argv, cwd: process.cwd(), prompt: promptFile && existsSync(promptFile) ? readFileSync(promptFile, 'utf8') : null, settings: settingsJson,
    addDir, addDirSkills: addDir ? names(join(addDir, '.claude/skills')) : null, piSkill: arg('--skill'), piSkills: names(arg('--skill')),
    resume: arg('--resume') || arg('--session'), piRoot: process.env.STUDIO_PI_ROOT || null });
  let initialized = false;
  for await (const line of createInterface({ input: process.stdin })) {
    let m; try { m = JSON.parse(line); } catch { continue; }
    const turn = async (text) => {
      log({ kind: 'message', text });
      if (text.includes('SLOW')) await new Promise((r) => setTimeout(r, 2500));
    };
    if (engine === 'claude' && m.type === 'user') {
      const text = typeof m.message?.content === 'string' ? m.message.content : JSON.stringify(m.message?.content);
      await turn(text);
      if (!initialized) { initialized = true; out({ type: 'system', subtype: 'init', session_id: `fixture-${process.pid}`, model: 'fixture-model' }); }
      out({ type: 'assistant', message: { content: [{ type: 'text', text: 'Fixture reply.' }] } });
      out({ type: 'result', subtype: 'success', is_error: false, duration_ms: 1 });
    } else if (engine === 'codex' && m.id != null && m.method) {
      if (m.method === 'skills/extraRoots/set') log({ kind: 'codex-roots', roots: m.params.extraRoots, names: m.params.extraRoots.map(names) });
      let result = {};
      if (/^thread\/(start|resume)$/.test(m.method)) {
        log({ kind: 'codex-thread', method: m.method, cwd: m.params.cwd, prompt: m.params.developerInstructions });
        result = { thread: { id: `fixture-thread-${process.pid}` }, model: 'fixture-model' };
      }
      out({ id: m.id, result });
      if (m.method === 'turn/start') {
        await turn(m.params.input.map((i) => i.text).join('\n'));
        out({ method: 'turn/started', params: { turn: { id: 't1' } } });
        out({ method: 'item/completed', params: { item: { type: 'agentMessage', text: 'Fixture reply.' } } });
        out({ method: 'turn/completed', params: { turn: { id: 't1', status: 'completed', durationMs: 1 } } });
      }
    } else if (engine === 'pi' && m.id != null) {
      const sessionFile = join(process.cwd(), `.fixture-pi-${process.pid}.jsonl`);
      if (m.type === 'get_state') { mkdirSync(dirname(sessionFile), { recursive: true }); writeFileSync(sessionFile, ''); }
      out({ type: 'response', id: m.id, command: m.type, success: true, data: m.type === 'get_state' ? { sessionFile, sessionId: `pi-${process.pid}`, model: { id: 'fixture-model', contextWindow: 128000 } } : {} });
      if (m.type === 'prompt') {
        await turn(String(m.message || ''));
        out({ type: 'agent_start' });
        out({ type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: 'Fixture reply.' }] } });
        out({ type: 'agent_end', messages: [] });
        out({ type: 'agent_settled', aborted: false });
      }
    }
  }
}

const freePort = () => new Promise((done, fail) => {
  const s = createServer();
  s.once('error', fail);
  s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => done(port)); });
});

// One disposable app + studio + server. Markers: an install-wide colour and font, a Setup-interview brand and a legacy
// BRAND.md, none of which may reach a surface where channel profiles apply.
async function startServer(t, engine, { settings = {} } = {}) {
  const root = mkdtempSync(join(realpathSync(tmpdir()), `octopus-agent-scope-${engine}-`));
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
  const packages = { claude: '@anthropic-ai/claude-code', codex: '@openai/codex', pi: '@earendil-works/pi-coding-agent' };
  for (const [name, pkg] of Object.entries(packages)) {
    write(join(bin, `${name}.cmd`), 'unused npm shim fixture');
    write(join(bin, 'node_modules', pkg, 'package.json'), JSON.stringify({ type: 'module', bin: 'fixture.mjs' }));
    write(join(bin, 'node_modules', pkg, 'fixture.mjs'), `(${fakeCLI.toString()})().catch((e) => { console.error(e.stack); process.exitCode = 1; });\n`);
  }
  const shell = join(root, 'fixture-shell');
  write(shell, `#!${process.execPath}\nprocess.stdout.write('__P__' + process.env.PATH + '__P__');\n`);
  if (process.platform !== 'win32') execFileSync('chmod', ['700', shell]);
  const port = await freePort();
  write(join(local, 'settings.json'), JSON.stringify({
    studio, setup: { done: true, agent: '' }, updates: { auto: false }, scheduleCatchUp: false, permissionMode: 'auto', help: { stepsIntro: 'dismissed' },
    claude: { engine, lean: true, ccSource: 'plan', codexProvider: 'chatgpt', piSource: 'pi' },
    look: { colors: ['#ff00aa'], fonts: 'INSTALL-WIDE-FONT' },
    claudePath: join(bin, 'claude.cmd'), codexPath: join(bin, 'codex.cmd'), piPath: join(bin, 'pi.cmd'), ...settings,
  }));
  write(join(local, 'schedules.json'), '{"v":1,"schedules":[]}');
  write(join(local, 'profile.json'), JSON.stringify({ who: 'SETUP-INTERVIEW-WHO', brand: 'SETUP-INTERVIEW-BRAND' }));
  const LOG = join(root, 'wire.jsonl');
  writeFileSync(LOG, '');
  const env = {
    PATH: [bin, dirname(process.execPath), process.env.PATH].join(process.platform === 'win32' ? ';' : ':'),
    HOME: home, USERPROFILE: home, SHELL: shell, TMPDIR: root, TMP: root, TEMP: root, STUDIO_LOCAL_DIR: local, STUDIO_NO_OPEN: '1', STUDIO_NO_SCHEDULES: '1',
    CLAUDE_CONFIG_DIR: join(home, '.claude'), CODEX_HOME: join(home, '.codex'), PI_CODING_AGENT_DIR: join(home, '.pi'), HF_HUB_OFFLINE: '1',
    PORT: String(port), OCTOPUS_TEST_ENGINE: engine, OCTOPUS_TEST_LOG: LOG, LC_ALL: 'C',
    ...(process.platform === 'win32' ? { SystemRoot: process.env.SystemRoot, ComSpec: process.env.ComSpec } : {}),
  };
  execFileSync(process.execPath, ['--input-type=module', '-e', 'const {createStudio}=await import(process.argv[1]);createStudio(process.argv[2],{use:false});',
    new URL(`file://${join(app, 'server/starter.mjs').replaceAll('\\', '/').replace(/^(?=[A-Za-z]:)/, '/')}`).href, studio], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  write(join(studio, 'BRAND.md'), '# LEGACY-BRAND-MARKER\n');
  const child = spawn(process.execPath, [join(app, 'server/index.mjs')], { cwd: app, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let logs = '';
  child.stdout.on('data', (b) => { logs += b; });
  child.stderr.on('data', (b) => { logs += b; });
  const url = `http://127.0.0.1:${port}`;
  const stop = async () => {
    if (child.exitCode === null) { child.kill(); for (let i = 0; i < 50 && child.exitCode === null && child.signalCode === null; i++) await sleep(100); }
    rmSync(root, { recursive: true, force: true, maxRetries: 5 });
  };
  t.after(stop);
  const req = async (path, data) => {
    const r = await fetch(url + path, data === undefined ? {} : { method: 'POST', headers: { 'X-Studio': '1', 'Content-Type': 'application/json' }, body: JSON.stringify(data) });
    const text = await r.text();
    let body; try { body = JSON.parse(text); } catch { body = text; }
    return { status: r.status, body };
  };
  const ok = async (path, data) => { const r = await req(path, data); assert.equal(r.status, 200, `${path}: ${JSON.stringify(r.body)}`); return r.body; };
  for (let i = 0; i < 200; i++) {
    if (child.exitCode !== null) throw new Error(logs);
    try { if ((await fetch(`${url}/api/learning`)).ok) break; } catch {}
    await sleep(100);
  }
  const wire = () => readFileSync(LOG, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  const messages = () => wire().filter((w) => w.kind === 'message');
  // Send through a route and wait for the fake agent to receive the message; returns what reached it.
  const turn = async (path, data) => {
    const before = wire().length, seen = messages().length;
    const r = await req(path, data);
    for (let i = 0; i < 150 && r.status === 200 && messages().length <= seen; i++) await sleep(50);
    await sleep(150);
    const rows = wire().slice(before);
    return { ...r, rows, launch: rows.find((w) => w.kind === 'launch'), thread: rows.find((w) => w.kind === 'codex-thread'), roots: rows.find((w) => w.kind === 'codex-roots'), message: rows.find((w) => w.kind === 'message') };
  };
  const db = (fn) => { const d = new DatabaseSync(join(studio, '.studio/studio.sqlite')); d.exec('PRAGMA busy_timeout=5000'); try { return fn(d); } finally { d.close(); } };
  return { root, app, studio, local, url, req, ok, turn, wire, db, logs: () => logs };
}

// Two channels (Alpha, Beta) with their own brands, one short format each with an approved v1.
async function channels(s) {
  const L = (p, d) => s.ok(`/api/learning${p}`, d);
  const approve = async (sessionId) => {
    const p = await L(`/sessions/${sessionId}/proposal`);
    return L(`/sessions/${sessionId}/approve`, { revision: p.revision, token: p.token, decisions: [...p.rules, ...p.removals].map((r) => ({ id: r.id, action: 'keep' })) });
  };
  const A = await L('/profiles', { name: 'Alpha channel' }), B = await L('/profiles', { name: 'Beta channel' });
  const brands = {};
  for (const [p, mark] of [[A, 'ALPHA-BRAND-MARKER'], [B, 'BETA-BRAND-MARKER']]) {
    brands[p.id] = (await s.ok(`/api/profiles/${p.id}/brand`, { expected: null, brand: { identity: mark, audience: '', voice: '', fonts: '', notes: '', colors: [], sources: [], assets: [] } })).id;
  }
  const FA = await L('/formats', { profileId: A.id, name: 'Alpha shorts', type: 'short', targetSeconds: 30 });
  const FB = await L('/formats', { profileId: B.id, name: 'Beta shorts', type: 'short', targetSeconds: 30 });
  const va1 = await approve((await L(`/formats/${FA.id}/draft-rule`, { area: 'visuals', text: 'RULE-A-V1 red titles.' })).session.id);
  const vb1 = await approve((await L(`/formats/${FB.id}/draft-rule`, { area: 'visuals', text: 'RULE-B-V1 green titles.' })).session.id);
  const skill = (f) => `format-${f.id.replace(/-/g, '').slice(0, 8)}`;
  return { A, B, FA, FB, va1, vb1, brands, approve, L, skillA: skill(FA), skillB: skill(FB) };
}

test('D1/S3: a cross-channel upgrade is refused before anything is written; a channel-less upgrade takes the brand and keeps memories; a broken pin can be repaired', async (t) => {
  const s = await startServer(t, 'claude');
  const c = await channels(s);
  const beta = (await s.ok('/api/projects', { name: 'Beta only video', type: 'short', profileId: c.B.id })).id;
  const row = (id) => s.db((d) => d.prepare('SELECT data FROM project_context WHERE project=?').get(id)?.data);
  const before = { context: row(beta), meta: readFileSync(join(s.studio, 'projects', beta, 'project.json'), 'utf8') };
  // Audit receipt: 400 "Pinned brand is missing." with the rows already committed. Now: refused, nothing written.
  const refused = await s.req(`/api/learning/projects/${beta}/upgrade`, { expected: null, versionId: c.va1.id, entry: 'idea', build: 'scene' });
  assert.equal(refused.status, 400);
  assert.match(refused.body.error, /belongs to the channel “Beta channel”/);
  assert.equal(row(beta), before.context);
  assert.equal(readFileSync(join(s.studio, 'projects', beta, 'project.json'), 'utf8'), before.meta);
  assert.equal(s.db((d) => d.prepare('SELECT 1 FROM project_learning WHERE project=?').get(beta)), undefined);
  assert.equal((await s.req(`/api/project-context/${beta}`)).status, 200);

  // A plain project with a chat (memory binding: global + project) upgraded into Alpha: the preview names the brand and
  // memory changes, the upgrade takes Alpha's brand, and the chat's memory binding follows (no "scope changed").
  const plain = (await s.ok('/api/projects', { name: 'Plain video', type: 'short' })).id;
  assert.equal((await s.turn(`/api/projects/${plain}/chat`, { text: 'first' })).status, 200);
  const preview = await s.ok(`/api/learning/projects/${plain}/upgrade-preview`, { versionId: c.va1.id });
  assert.ok(preview.notices.some((n) => /Brand: this video now uses Alpha channel's approved brand/.test(n)));
  assert.ok(preview.notices.some((n) => /Memories:/.test(n)));
  const up = await s.ok(`/api/learning/projects/${plain}/upgrade`, { expected: null, versionId: c.va1.id, entry: 'idea', build: 'scene' });
  assert.equal(up.notices.length, 2);
  assert.equal(JSON.parse(row(plain)).brandVersion, c.brands[c.A.id]);
  const scopes = JSON.parse(s.db((d) => d.prepare('SELECT data FROM memory_chats WHERE id=?').get(plain).data)).scopes;
  assert.deepEqual(scopes, ['global', `profile:${c.A.id}`, `format:${c.FA.id}`, `project:${plain}`]);
  assert.match(readFileSync(join(s.studio, 'projects', plain, 'WORKLOG.md'), 'utf8'), /Upgraded to Alpha shorts v1\. Brand:/);
  const next = await s.turn(`/api/projects/${plain}/chat`, { text: 'after upgrade' });
  assert.equal(next.status, 200);
  assert.match(next.message.text, /ALPHA-BRAND-MARKER/, 'the updated context (Alpha brand) rides along with the next message');
  const log = readFileSync(join(s.local, 'chats', `${plain}.jsonl`), 'utf8');
  assert.doesNotMatch(log, /Memories unavailable/);

  // A project broken by the old upgrade (Alpha profile, Beta's brand version): the panel's Repair re-pins Alpha's brand.
  const broken = { ...JSON.parse(row(beta)), profileId: c.A.id, profileName: 'Alpha channel', formatId: c.FA.id, formatName: 'Alpha shorts', versionId: c.va1.id };
  s.db((d) => d.prepare('UPDATE project_context SET data=? WHERE project=?').run(JSON.stringify(broken), beta));
  const bad = await s.req(`/api/project-context/${beta}`);
  assert.equal(bad.status, 400);
  const repaired = await s.ok(`/api/project-context/${beta}/repair`, {});
  assert.ok(repaired.changes.some((x) => /Brand: Alpha channel's current approved brand/.test(x)));
  const good = await s.ok(`/api/project-context/${beta}`);
  assert.equal(good.bundle.brandVersion, c.brands[c.A.id]);
  assert.equal((await s.turn(`/api/projects/${beta}/chat`, { text: 'after repair' })).status, 200);
});

test('D2: archiving stops the chat and keeps its state; a new project with the same name starts clean; the archived one restores as it was', async (t) => {
  const s = await startServer(t, 'claude');
  const c = await channels(s);
  const first = (await s.ok('/api/learning/projects', { name: 'Reused name', versionId: c.va1.id, entry: 'idea', build: 'scene' })).id;
  const one = await s.turn(`/api/projects/${first}/chat`, { text: 'first project message' });
  assert.equal(one.status, 200);
  const pid = one.launch.pid;
  await s.ok(`/api/projects/${first}/archive`, {});
  for (let i = 0; i < 50; i++) { try { process.kill(pid, 0); } catch { break; } await sleep(100); }
  assert.throws(() => process.kill(pid, 0), 'the archived project\'s agent process stopped');
  const second = (await s.ok('/api/projects', { name: 'Reused name', type: 'short' })).id;
  assert.notEqual(second, first, 'a name whose id still has saved state gets the next free id');
  assert.equal(s.db((d) => d.prepare('SELECT 1 FROM project_learning WHERE project=?').get(second)), undefined);
  assert.equal(s.db((d) => d.prepare('SELECT 1 FROM memory_chats WHERE id=?').get(second)), undefined);
  const fresh = await s.turn(`/api/projects/${second}/chat`, { text: 'new project message' });
  assert.ok(fresh.launch, 'a new agent process');
  assert.notEqual(fresh.launch.pid, pid);
  assert.equal(fresh.launch.resume, null, 'no earlier session is continued');
  assert.doesNotMatch(readFileSync(join(s.local, 'chats', `${second}.jsonl`), 'utf8'), /first project message/);
  // Restore: same id, its pin and chat log intact.
  await s.ok('/api/app/archive', { op: 'restore', id: first });
  const view = await s.ok(`/api/projects/${first}`);
  assert.equal(view.learning?.versionId, c.va1.id);
  assert.match(readFileSync(join(s.local, 'chats', `${first}.jsonl`), 'utf8'), /first project message/);
});

for (const engine of ['claude', 'codex', 'pi']) {
  test(`D4/S1 (${engine}): a scheduled run on a pinned project gets the project's pin, and project chats are told their real working directory`, async (t) => {
    const s = await startServer(t, engine);
    const c = await channels(s);
    const pinned = (await s.ok('/api/learning/projects', { name: 'Alpha video', versionId: c.va1.id, entry: 'idea', build: 'scene' })).id;
    const projectDir = join(s.studio, 'projects', pinned), skills = join(projectDir, '.octopus', 'context', '.claude', 'skills');
    const sched = await s.ok('/api/app/schedules', { op: 'save', schedule: { name: 'Pinned run', cron: '0 3 * * *', scope: `project:${pinned}`, mode: 'report', prompt: 'PROBE run', enabled: false } });
    const run = await s.turn('/api/app/schedules', { op: 'run', id: sched.saved });
    assert.equal(run.status, 200);
    const prompt = engine === 'codex' ? run.thread.prompt : run.launch.prompt;
    assert.match(prompt, /Project context is pinned in SQLite/);
    assert.match(prompt, /ALPHA-BRAND-MARKER/);
    for (const leak of ['#ff00aa', 'INSTALL-WIDE-FONT', 'SETUP-INTERVIEW-BRAND', 'Read it before planning']) assert.ok(!prompt.includes(leak), `run prompt has ${leak}`);
    if (engine === 'claude') {
      assert.equal(run.launch.addDir, join(projectDir, '.octopus', 'context'));
      assert.ok(run.launch.addDirSkills.includes(`${c.skillA}-v1`), 'the pinned copy, under its own name');
      assert.ok(run.launch.settings.skillOverrides[c.skillB] === 'off', 'the other channel\'s format skill is hidden');
      assert.ok(run.launch.settings.skillOverrides[c.skillA] === 'off', 'the studio copy of its own format is hidden too');
    }
    if (engine === 'codex') assert.deepEqual(run.roots.roots, [skills]);
    if (engine === 'pi') assert.equal(run.launch.piSkill, skills);
    // The interactive chat: runs in the project folder and says so.
    const chat = await s.turn(`/api/projects/${pinned}/chat`, { text: 'hello' });
    const context = engine === 'codex' ? chat.thread.prompt : chat.launch.prompt;
    assert.equal(engine === 'codex' ? chat.thread.cwd : chat.launch.cwd, projectDir);
    assert.ok(context.includes(`Your working directory is this project's folder, ${projectDir}`));
    assert.ok(context.includes(`The studio folder is ${s.studio}.`));
    assert.doesNotMatch(context, /Your studio folder \(your working directory\)/);
    assert.match(context, /Project folder: projects\/alpha-video \(inside the studio/);
    if (engine === 'pi') assert.equal(chat.launch.piRoot, projectDir, 'pi Auto writes are bounded by the project, like Claude Code\'s outside-project check');
  });
}

for (const engine of ['claude', 'codex', 'pi']) {
  test(`S4 (${engine}): format conversations see only their channel's format skills; brand research sees none`, async (t) => {
    const s = await startServer(t, engine);
    const c = await channels(s);
    const session = await s.ok('/api/learning/sessions', { formatId: c.FA.id, name: 'Scope check' });
    const learn = await s.turn(`/api/learning/sessions/${session.id}/chat`, { text: 'PROBE learning' });
    assert.equal(learn.status, 200);
    const research = await s.ok(`/api/profiles/${c.B.id}/research`, { url: 'https://example.com/beta', direction: 'PROBE' });
    const brand = await s.turn(`/api/profile-research/${research.id}/chat`, { text: 'PROBE research', revision: research.revision });
    assert.equal(brand.status, 200);
    const seen = (r) => engine === 'codex' ? r.roots.names[0] : engine === 'pi' ? r.launch.piSkills : r.launch.addDirSkills;
    // P3: the prompt's skill inventory names only what the chat can load (no other channel's skill, nothing in research).
    const prompt = (r) => engine === 'codex' ? r.thread.prompt : r.launch.prompt;
    assert.ok(prompt(learn).includes(c.skillA), 'its own channel\'s format skill is listed');
    assert.ok(!prompt(learn).includes(c.skillB), 'the other channel\'s format skill is not named');
    assert.ok(!prompt(learn).includes(c.FB.id), 'nor its format id');
    assert.doesNotMatch(prompt(learn), /active \.claude\/skills publication/);
    assert.ok(!prompt(brand).includes(c.skillA) && !prompt(brand).includes(c.skillB), 'brand research is told about no format skill');
    assert.ok(seen(learn).includes(c.skillA));
    assert.ok(!seen(learn).includes(c.skillB), 'the other channel\'s format skill is not in the conversation\'s skill root');
    assert.ok(seen(learn).includes('transcribe'), 'core skills stay');
    assert.ok(!seen(brand).some((n) => n.startsWith('format-')), 'brand research gets no format skills');
    if (engine === 'claude') {
      for (const r of [learn, brand]) {
        assert.ok(r.launch.settings.claudeMdExcludes.includes(join(s.studio, 'CLAUDE.md').replaceAll('\\', '/')), 'the studio CLAUDE.md is excluded');
        assert.equal(r.launch.settings.skillOverrides[c.skillB], 'off');
      }
      assert.equal(brand.launch.settings.skillOverrides[c.skillA], 'off');
    }
  });
}

for (const engine of ['claude', 'codex', 'pi']) {
  test(`P1 (${engine}): a project pinned to v1 loads its own v1 copy after v2 is approved, never the studio's v2 skill`, async (t) => {
    const s = await startServer(t, engine);
    const c = await channels(s);
    const pinned = (await s.ok('/api/learning/projects', { name: 'Pinned alpha', versionId: c.va1.id, entry: 'idea', build: 'scene' })).id;
    const v2 = await c.approve((await c.L(`/formats/${c.FA.id}/draft-rule`, { area: 'visuals', text: 'ORANGE-FOX titles from v2.' })).session.id);
    assert.equal(v2.number, 2);
    assert.match(readFileSync(join(s.studio, '.claude/skills', c.skillA, 'SKILL.md'), 'utf8'), /ORANGE-FOX/, 'the studio skill follows v2');
    const chat = await s.turn(`/api/projects/${pinned}/chat`, { text: 'Which format skills do you see?' });
    assert.equal(chat.status, 200);
    const pinnedName = `${c.skillA}-v1`, skills = join(s.studio, 'projects', pinned, '.octopus/context/.claude/skills');
    const copy = readFileSync(join(skills, pinnedName, 'SKILL.md'), 'utf8');
    assert.match(copy, new RegExp(`^---\\nname: ${pinnedName}\\n`));
    assert.match(copy, /RULE-A-V1/);
    assert.doesNotMatch(copy, /ORANGE-FOX/);
    const seen = engine === 'codex' ? chat.roots.names[0] : engine === 'pi' ? chat.launch.piSkills : chat.launch.addDirSkills;
    assert.ok(seen.includes(pinnedName), 'the pinned copy is loaded');
    assert.ok(!seen.includes(c.skillA) && !seen.includes(c.skillB), 'no studio format skill in the chat\'s skill root');
    const prompt = engine === 'codex' ? chat.thread.prompt : chat.launch.prompt;
    assert.ok(prompt.includes(`use only ${pinnedName}.`));
    assert.doesNotMatch(prompt, /ORANGE-FOX/);
    if (engine === 'claude') {
      assert.deepEqual(chat.launch.settings.skillOverrides, { [c.skillA]: 'off', [c.skillB]: 'off' }, 'every studio format skill is off; the pinned copy is not');
    }
    // A new video takes v2.
    const fresh = (await s.ok('/api/learning/projects', { name: 'New alpha', versionId: v2.id, entry: 'idea', build: 'scene' })).id;
    const context = await s.ok(`/api/project-context/${fresh}`);
    assert.equal(context.bundle.versionId, v2.id);
    assert.ok(existsSync(join(s.studio, 'projects', fresh, '.octopus/context/.claude/skills', `${c.skillA}-v2`, 'SKILL.md')));
  });
}

test('P1 migration: a project pinned before pinned copies had their own name gets the new copy; the old folder is kept aside', async (t) => {
  const s = await startServer(t, 'claude');
  const c = await channels(s);
  const pinned = (await s.ok('/api/learning/projects', { name: 'Old pin', versionId: c.va1.id, entry: 'idea', build: 'scene' })).id;
  const projectDir = join(s.studio, 'projects', pinned), skills = join(projectDir, '.octopus/context/.claude/skills');
  await s.ok(`/api/project-context/${pinned}`);
  // What a project from beta.11 has: the pinned copy under the studio skill's name, here with an edit of its own.
  const { renameSync } = await import('node:fs');
  renameSync(join(skills, `${c.skillA}-v1`), join(skills, c.skillA));
  appendFileSync(join(skills, c.skillA, 'SKILL.md'), '\nOLD-PIN-EDIT\n');
  const chat = await s.turn(`/api/projects/${pinned}/chat`, { text: 'hello' });
  assert.equal(chat.status, 200);
  assert.deepEqual(chat.launch.addDirSkills.filter((n) => n.startsWith('format-')), [`${c.skillA}-v1`]);
  assert.equal(chat.launch.settings.skillOverrides[c.skillA], 'off');
  const aside = join(projectDir, '.octopus/replaced-format-skills');
  const kept = readdirSync(aside);
  assert.equal(kept.length, 1);
  assert.ok(kept[0].endsWith(`-${c.skillA}`));
  assert.match(readFileSync(join(aside, kept[0], 'SKILL.md'), 'utf8'), /OLD-PIN-EDIT/);
});

test('S5: a stray edit to one generated skill no longer blocks other chats; a rebuild that had to wait runs once work is idle', async (t) => {
  const s = await startServer(t, 'claude');
  const c = await channels(s);
  const skillFile = join(s.studio, '.claude/skills', c.skillA, 'SKILL.md');
  const saved = readFileSync(skillFile, 'utf8');
  appendFileSync(skillFile, '\nAGENT IMPROVEMENT\n');
  // Audit receipt A1: 500 "Skill files changed" for the assistant. Now the chat goes ahead and the edit is kept aside.
  const assistant = await s.turn('/api/projects/_studio/chat', { text: 'hello' });
  assert.equal(assistant.status, 200);
  assert.equal(readFileSync(skillFile, 'utf8'), saved);
  const aside = readdirSync(join(s.studio, '.studio/edited-skill-files')).find((n) => n.endsWith(c.skillA));
  assert.match(readFileSync(join(s.studio, '.studio/edited-skill-files', aside, 'SKILL.md'), 'utf8'), /AGENT IMPROVEMENT/);
  assert.match(readFileSync(join(s.local, 'chats', '_studio.jsonl'), 'utf8'), /put its saved version back/);
  // Audit receipt E2: approve while an agent is busy → current:false forever. Now it updates once the turn ends.
  const plain = (await s.ok('/api/projects', { name: 'Busy one', type: 'short' })).id;
  const busy = s.req(`/api/projects/${plain}/chat`, { text: 'SLOW please' });
  await sleep(800);
  const v2 = await c.approve((await c.L(`/formats/${c.FA.id}/draft-rule`, { area: 'visuals', text: 'Busy approve.' })).session.id);
  assert.match(v2.warning, /will update when current work finishes/);
  assert.equal((await s.ok(`/api/learning/formats/${c.FA.id}/skill`)).current, false);
  await busy;
  let view;
  for (let i = 0; i < 60; i++) { view = await s.ok(`/api/learning/formats/${c.FA.id}/skill`); if (view.current) break; await sleep(250); }
  assert.equal(view.current, true);
  assert.equal(view.activeNumber, 2);
  assert.match(readFileSync(skillFile, 'utf8'), /Busy approve\./);
});

test('S6/S7: no install-wide brand lines where channel profiles apply; Instructions says which videos keep an older version', async (t) => {
  const s = await startServer(t, 'claude');
  await channels(s);
  await s.ok('/api/projects', { name: 'Plain video', type: 'short' });
  const assistant = await s.turn('/api/projects/_studio/chat', { text: 'hello' });
  for (const leak of ['#ff00aa', 'INSTALL-WIDE-FONT', 'SETUP-INTERVIEW-BRAND', 'Read it before planning']) assert.ok(!assistant.launch.prompt.includes(leak), `assistant prompt has ${leak}`);
  assert.match(assistant.launch.prompt, /SETUP-INTERVIEW-WHO/, 'what the creator told Setup about themselves stays');
  assert.match(assistant.launch.prompt, /There is no studio-wide brand to apply/);
  const ins = await s.ok('/api/instructions');
  assert.deepEqual(ins.pinned, { projects: 1, older: 0 });
  await s.ok('/api/instructions', { files: { ...ins.current.files, 'CLAUDE.md': `${ins.current.files['CLAUDE.md']}\nEDIT\n` }, expected: ins.current.id });
  assert.deepEqual((await s.ok('/api/instructions')).pinned, { projects: 1, older: 1 });
});

for (const engine of ['claude', 'codex', 'pi']) {
  test(`M2 (${engine}): a start failure is an error status on every engine`, async (t) => {
    const s = await startServer(t, engine, { settings: { [`${engine}Path`]: join(tmpdir(), 'no-such-agent', engine) } });
    const plain = (await s.ok('/api/projects', { name: 'Plain video', type: 'short' })).id;
    const r = await s.req(`/api/projects/${plain}/chat`, { text: 'hello' });
    // Audit receipt: Codex and pi answered 200 and only the chat showed the error; Claude Code answered with an error.
    assert.ok(r.status >= 400, `status ${r.status}`);
    assert.match(r.body.error, /there's nothing there/);
    const project = await s.ok(`/api/projects/${plain}`);
    assert.equal(project.busy, false);
  });
}

test('M1 (codex): switching the provider starts a new session instead of continuing the other provider\'s thread', async (t) => {
  const s = await startServer(t, 'codex', { settings: { ollamaUrl: 'http://127.0.0.1:9' } });
  const plain = (await s.ok('/api/projects', { name: 'Plain video', type: 'short' })).id;
  const first = await s.turn(`/api/projects/${plain}/chat`, { text: 'on chatgpt' });
  assert.equal(first.thread.method, 'thread/start');
  const again = await s.turn(`/api/projects/${plain}/chat`, { text: 'still chatgpt' });
  assert.equal(again.launch, undefined, 'the same provider keeps its process');
  await s.ok('/api/app/settings', { section: 'claude', values: { engine: 'codex', lean: true, ccSource: 'plan', codexProvider: 'ollama', piSource: 'pi' } });
  const switched = await s.turn(`/api/projects/${plain}/chat`, { text: 'on ollama' });
  assert.equal(switched.status, 200);
  assert.ok(switched.launch, 'a new Codex process');
  assert.equal(switched.thread.method, 'thread/start', 'audit receipt: the ChatGPT thread was resumed on the new provider');
  const sessions = await s.ok(`/api/projects/${plain}/chat-sessions`, {});
  assert.equal(sessions.earlier.length, 1, 'the ChatGPT conversation went to earlier sessions');
});
