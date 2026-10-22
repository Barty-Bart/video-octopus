// Disposable runtime check for the format skill (phase 1 backend). No genuine agents, sign-ins, models,
// network or creator studios: a copied app, a fresh studio in a temporary folder, a fake `claude` and a
// network guard that only allows localhost.
//   node test/format-skill-integration.mjs
// Flow: study → save v1 → chat edit with instruction evidence → save v2 → a project pinned to v1 still gets v1
// (context and its own format skill copy, through Claude's --add-dir) → the studio format skill follows v2,
// rename/archive/restore, the direct-edit endpoint and the videos query.
import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync, mkdirSync, cpSync, writeFileSync, readFileSync, chmodSync, existsSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';

const source = resolve(dirname(fileURLToPath(import.meta.url)), '..');
// macOS temp folders are symlinks and the app refuses symlinked storage: use the real path.
const root = realpathSync(mkdtempSync(join(tmpdir(), 'octopus-format-skill-runtime-')));
const app = join(root, 'app'), studio = join(root, 'studio'), home = join(root, 'home'), local = join(root, 'local'), bin = join(root, 'bin');
const port = Number(process.env.OCTOPUS_TEST_PORT || 43851), url = `http://127.0.0.1:${port}`;
if (port === 4800) throw new Error('Never use the installed app port.');
const put = (p, s) => { mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, s); };
for (const p of [app, studio, home, local, bin]) mkdirSync(p, { recursive: true });
for (const p of ['server', 'web', 'core', 'starter', 'bin', 'package.json']) cpSync(join(source, p), join(app, p), { recursive: true });
put(join(app, 'server/keychain.mjs'), `export const KEY_STORE='Synthetic fixture';export async function readKey(){return null;}export async function hasKey(){return false;}export async function saveKey(){throw Error('Fixture forbids credentials');}export async function removeKey(){throw Error('Fixture forbids credentials');}`);
const path = [bin, dirname(process.execPath), '/usr/bin', '/bin', '/usr/sbin', '/sbin'].join(':');
put(join(bin, 'fixture-shell'), `#!/bin/sh\nprintf '__P__%s__P__' '${path}'\n`);
chmodSync(join(bin, 'fixture-shell'), 0o755);
for (const name of ['codex', 'pi', 'lms', 'ollama']) { put(join(bin, name), '#!/bin/sh\necho "Synthetic fixture: no real agent" >&2\nexit 1\n'); chmodSync(join(bin, name), 0o755); }

// The fake Claude Code. In a format conversation it writes drafts (study → v1 rules; a creator request →
// a change citing that message's ID). In a project chat it reports what it was given.
async function fakeAgent() {
  const { writeFileSync, mkdirSync, existsSync, readdirSync, readFileSync } = await import('node:fs');
  const { join } = await import('node:path');
  const { createInterface } = await import('node:readline');
  const argv = process.argv.slice(2);
  if (argv.includes('--version')) { console.log('9.9.9 synthetic'); return; }
  if (argv[0] === 'auth') { console.log('{"loggedIn":true,"authMethod":"fixture"}'); return; }
  const context = argv[argv.indexOf('--append-system-prompt') + 1];
  const addDir = argv.includes('--add-dir') ? argv[argv.indexOf('--add-dir') + 1] : null;
  const isLearning = context.includes('This is a learning session');
  const out = (x) => console.log(JSON.stringify(x));
  for await (const line of createInterface({ input: process.stdin })) {
    let x; try { x = JSON.parse(line); } catch { continue; }
    if (x.type !== 'user') continue;
    out({ type: 'system', subtype: 'init', session_id: `fixture-${randomish()}`, model: 'synthetic' });
    const message = String(x.message?.content || '');
    mkdirSync(join(process.cwd(), 'work'), { recursive: true });
    if (isLearning) {
      const session = JSON.parse((message.match(/^Session: (.+)$/m) || context.match(/^Session: (.+)$/m))[1]);
      const referenceId = session.references[0]?.id;
      const messageId = message.match(/original user message ID for (?:memory|instruction) evidence: ([^\]]+)/)?.[1] || null;
      const draft = join(process.cwd(), 'work', 'proposal.json');
      if (messageId && message.includes('use blue instead of red')) {
        const evidence = [{ kind: 'instruction', messageId, quote: 'use blue instead of red' }];
        writeFileSync(draft, JSON.stringify({
          rules: [{ id: 'colour', area: 'visuals', text: 'Use blue accents instead of red.', confidence: 'high', evidence }],
          remove: [{ id: 'outro', evidence: [{ kind: 'instruction', messageId, quote: 'drop the outro hold' }] }],
          learnings: [{ text: 'The creator prefers cool accent colours.', evidence }],
        }));
      } else if (referenceId && message.startsWith('Study the supplied references')) {
        const evidence = [{ referenceId, note: '00:02: synthetic observation.' }];
        writeFileSync(draft, JSON.stringify({
          rules: [
            { id: 'opening', area: 'scripting', text: 'Show the finished result first, in red.', confidence: 'medium', evidence },
            { id: 'outro', area: 'pacing', text: 'Hold the last frame for two seconds.', confidence: 'low', evidence },
          ],
          workflow: 'Draft and review the script, lock the cut, approve the scene plan, build and review.',
          learnings: [{ text: 'Openings are short.', evidence }],
        }));
      }
      writeFileSync(join(process.cwd(), 'work', 'agent-receipt.json'), JSON.stringify({ messageId,
        continued: (context + message).includes('This conversation already saved v1'),
        knowsInstructions: context.includes('Turn the creator\'s plain-language requests'),
        knowsRemove: context.includes('remove one by listing it in "remove"') }));
    } else {
      const skills = addDir ? join(addDir, '.claude/skills') : null;
      const names = skills && existsSync(skills) ? readdirSync(skills) : [];
      const format = names.find((n) => /^format-[a-f0-9]{8}$/.test(n)) || null;
      writeFileSync(join(process.cwd(), 'work', 'agent-receipt.json'), JSON.stringify({ addDir, format,
        skill: format ? readFileSync(join(skills, format, 'SKILL.md'), 'utf8') : null,
        pinnedV1: /copy of .+ v1\. It is authoritative/.test(context), activeV2: context.includes("active skill is now v2, which does not apply here") }));
    }
    out({ type: 'assistant', message: { content: [{ type: 'text', text: 'Synthetic reply.' }] } });
    out({ type: 'result', subtype: 'success', is_error: false, duration_ms: 1 });
  }
  function randomish() { return Math.random().toString(16).slice(2, 10); }
}
put(join(bin, 'claude'), `#!${process.execPath}\n(${fakeAgent.toString()})().catch(e=>{console.error(e);process.exitCode=1;});\n`);
chmodSync(join(bin, 'claude'), 0o755);

const env = { HOME: home, USERPROFILE: home, TMPDIR: root, PATH: path, SHELL: join(bin, 'fixture-shell'), XDG_CONFIG_HOME: join(home, '.config'),
  XDG_CACHE_HOME: join(home, '.cache'), XDG_DATA_HOME: join(home, '.local/share'), CODEX_HOME: join(home, '.codex'), CLAUDE_CONFIG_DIR: join(home, '.claude'),
  PI_CODING_AGENT_DIR: join(home, '.pi'), HF_HOME: join(home, '.cache/hf'), HF_HUB_OFFLINE: '1', TRANSFORMERS_OFFLINE: '1', STUDIO_LOCAL_DIR: local,
  STUDIO_NO_OPEN: '1', STUDIO_NO_SCHEDULES: '1', PORT: String(port), STUDIO_KEYCHAIN_SERVICE: `octopus-format-skill-fixture-${process.pid}`,
  GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_TERMINAL_PROMPT: '0', LC_ALL: 'C' };
const guard = join(root, 'network-guard.mjs');
put(guard, `import net from 'node:net';import tls from 'node:tls';import {syncBuiltinESMExports} from 'node:module';const allow=new Set(['127.0.0.1','localhost','::1']);function check(args){const a=args[0],h=typeof a==='object'?a.hostname||a.host:typeof args[1]==='string'?args[1]:undefined;if(h&&!allow.has(h))throw Error('Fixture blocked remote network');}for(const [o,k] of [[net,'connect'],[net,'createConnection'],[tls,'connect']]){const f=o[k];o[k]=function(...a){check(a);return f.apply(this,a);};}const f=fetch;globalThis.fetch=(u,...a)=>{if(!allow.has(new URL(typeof u==='string'||u instanceof URL?u:u.url).hostname))throw Error('Fixture blocked remote fetch');return f(u,...a);};syncBuiltinESMExports();`);
env.NODE_OPTIONS = `--import=${guard}`;
put(join(local, 'settings.json'), JSON.stringify({ studio, setup: { done: true, agent: '' }, updates: { auto: false }, scheduleCatchUp: false,
  claude: { engine: 'claude', lean: true, useApiKey: false }, help: { stepsIntro: 'dismissed' },
  ...Object.fromEntries(['claude', 'codex', 'pi', 'lms', 'ollama'].map((n) => [`${n}Path`, join(bin, n)])) }));
put(join(local, 'schedules.json'), '{"v":1,"schedules":[]}');
execFileSync(process.execPath, ['--input-type=module', '-e', "const {createStudio}=await import(process.argv[1]);createStudio(process.argv[2],{use:false});",
  new URL(`file://${join(app, 'server/starter.mjs')}`).href, studio], { env, stdio: ['ignore', 'pipe', 'pipe'] });

const child = spawn(process.execPath, [join(app, 'server/index.mjs')], { cwd: app, env, stdio: ['ignore', 'pipe', 'pipe'] });
let logs = '';
child.stdout.on('data', (b) => { logs += b; });
child.stderr.on('data', (b) => { logs += b; });
const request = async (p, data, expected = 200) => {
  const r = await fetch(url + p, data === undefined ? {} : { method: 'POST', headers: { 'X-Studio': '1', 'Content-Type': 'application/json' }, body: JSON.stringify(data) });
  const j = await r.json();
  assert.equal(r.status, expected, `${p}: ${JSON.stringify(j)}`);
  return j;
};
const call = (p = '', data, expected) => request('/api/learning' + p, data, expected);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function ready() {
  for (let i = 0; i < 100; i++) {
    if (child.exitCode !== null) throw new Error(logs);
    try { await call(); return; } catch {}
    await sleep(100);
  }
  throw new Error('Server timeout\n' + logs);
}
async function idle(sessionId) {
  for (let i = 0; i < 200; i++) {
    const s = await call(`/sessions/${sessionId}`);
    if (s.status !== 'running' && !(await call(`/sessions/${sessionId}/chat-sessions`, { op: 'list' })).busy) return s;
    await sleep(50);
  }
  throw new Error('Conversation did not finish\n' + logs);
}
const approveAll = async (sessionId, overrides = {}) => {
  const p = await call(`/sessions/${sessionId}/proposal`);
  const decisions = [...p.rules, ...p.removals].map((r) => ({ id: r.id, action: 'keep', ...(overrides[r.id] || {}) }));
  return call(`/sessions/${sessionId}/approve`, { revision: p.revision, token: p.token, decisions });
};
const passed = [];
const check = async (name, fn) => { await fn(); passed.push(name); };

try {
  await ready();
  const profile = await call('/profiles', { name: 'Main YouTube' });
  let format = await call('/formats', { profileId: profile.id, name: 'Instagram reel', type: 'short', targetSeconds: 45 });
  const skillDir = join(studio, '.claude/skills', `format-${format.id.replace(/-/g, '').slice(0, 8)}`);
  let session = await call('/sessions', { formatId: format.id, name: 'Reel study' });
  session = await call(`/sessions/${session.id}/references`, { kind: 'note', name: 'Synthetic reel', note: '00:02: result first.', revision: session.revision });
  const receipt = () => JSON.parse(readFileSync(join(studio, '.studio/learning/sessions', session.id, 'work/agent-receipt.json'), 'utf8'));

  await call(`/sessions/${session.id}/run`, { revision: session.revision });
  session = await idle(session.id);
  let v1;
  await check('study writes a draft and saving it creates v1 and the format skill', async () => {
    assert.equal(session.status, 'review', session.error);
    v1 = await approveAll(session.id);
    assert.equal(v1.number, 1);
    assert.equal(v1.warning, null);
    const skill = readFileSync(join(skillDir, 'SKILL.md'), 'utf8');
    assert.match(skill, /Main YouTube › Instagram reel: approved Short format skill \(v1\)/);
    for (const f of ['rules.md', 'examples/examples.md', 'learnings.md', 'videos.md']) assert.ok(existsSync(join(skillDir, f)), f);
    assert.ok(existsSync(join(skillDir, 'assets')));
    assert.equal(readdirSync(join(studio, 'skills/custom')).some((n) => n.startsWith('learned-') || n.startsWith('format-')), false, 'nothing written into skills/custom');
    const skills = await call('/skills');
    const entry = skills.items.find((x) => x.kind === 'format');
    assert.equal(entry.label, 'Main YouTube › Instagram reel · v1');
  });

  let project;
  await check('a new video pins v1', async () => {
    project = await call('/projects', { name: 'Pinned to v1', versionId: v1.id, entry: 'idea', build: 'scene' });
    const context = await request(`/api/project-context/${project.id}`);
    assert.equal(context.formatSkill.number, 1);
  });

  await check('the conversation continues after approval', async () => {
    const s = await call(`/sessions/${session.id}`);
    assert.equal(s.status, 'draft');
    assert.equal(s.baseVersion, v1.id);
    assert.ok(existsSync(join(studio, '.studio/learning/sessions', session.id, `work/proposals/${v1.id}.json`)));
  });

  await call(`/sessions/${session.id}/chat`, { text: 'Next time please use blue instead of red, and drop the outro hold.' });
  session = await idle(session.id);
  let v2;
  await check('a plain-language request becomes a draft citing the creator message, saved as v2', async () => {
    const r = receipt();
    assert.ok(r.messageId, 'the agent received the creator message ID');
    assert.equal(r.continued, true);
    assert.equal(r.knowsInstructions && r.knowsRemove, true);
    const p = await call(`/sessions/${session.id}/proposal`);
    assert.deepEqual(p.rules.map((x) => [x.id, x.change]), [['colour', 'new']]);
    assert.deepEqual(p.rules[0].evidence, [{ kind: 'instruction', messageId: r.messageId, quote: 'use blue instead of red' }]);
    assert.deepEqual(p.removals.map((x) => [x.id, x.change]), [['outro', 'removed']]);
    const { DatabaseSync } = await import('node:sqlite');
    const db = new DatabaseSync(join(studio, '.studio/studio.sqlite'), { readOnly: true });
    try {
      const row = db.prepare('SELECT session_id, text FROM learning_messages WHERE id=?').get(r.messageId);
      assert.equal(row.session_id, session.id, 'the creator message is stored in SQLite for this conversation');
      assert.match(row.text, /use blue instead of red/);
    } finally { db.close(); }
    v2 = await approveAll(session.id);
    assert.equal(v2.number, 2);
    assert.equal(v2.warning, null);
    const version = await call(`/versions/${v2.id}`);
    assert.deepEqual(version.rules.map((x) => x.id).sort(), ['colour', 'opening']);
    assert.deepEqual(version.learnings.map((x) => x.text), ['Openings are short.', 'The creator prefers cool accent colours.']);
  });

  await check('a forged message ID is rejected', async () => {
    const draft = join(studio, '.studio/learning/sessions', session.id, 'work/proposal.json');
    writeFileSync(draft, JSON.stringify({ rules: [{ id: 'forged', area: 'visuals', text: 'Forged.', confidence: 'high',
      evidence: [{ kind: 'instruction', messageId: randomUUID(), quote: 'use blue instead of red' }] }] }));
    const error = await call(`/sessions/${session.id}/proposal`, undefined, 400);
    assert.match(error.error, /creator message/);
    rmSync(draft);
  });

  await check('the studio format skill now carries v2', async () => {
    const skill = readFileSync(join(skillDir, 'SKILL.md'), 'utf8');
    assert.match(skill, /\(v2\)/);
    assert.match(skill, /Use blue accents instead of red/);
    assert.match(readFileSync(join(skillDir, 'rules.md'), 'utf8'), /Edited in chat: "use blue instead of red"/);
    assert.match(readFileSync(join(skillDir, 'videos.md'), 'utf8'), /## v1\n\n- Pinned to v1/);
    const info = await call(`/formats/${format.id}/skill`);
    assert.equal(info.published, true); assert.equal(info.current, true); assert.equal(info.activeNumber, 2);
  });

  await request(`/api/projects/${project.id}/chat`, { text: 'What format rules apply here?' });
  const projectReceipt = join(studio, 'projects', project.id, 'work/agent-receipt.json');
  for (let i = 0; i < 200 && !existsSync(projectReceipt); i++) await sleep(50);
  await check('the project pinned to v1 still gets v1 (Claude: --add-dir with its own format skill copy)', async () => {
    const r = JSON.parse(readFileSync(projectReceipt, 'utf8'));
    assert.equal(r.addDir, join(studio, 'projects', project.id, '.octopus/context'));
    assert.equal(r.format, `format-${format.id.replace(/-/g, '').slice(0, 8)}`);
    assert.match(r.skill, /pinned to v1/);
    assert.match(r.skill, /Show the finished result first, in red/);
    assert.doesNotMatch(r.skill, /blue/);
    assert.equal(r.pinnedV1, true);
    assert.equal(r.activeV2, true);
  });

  await check('videos query lists the pinned project with its version', async () => {
    const rows = await call(`/formats/${format.id}/videos`);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].project, project.id); assert.equal(rows[0].name, 'Pinned to v1'); assert.equal(rows[0].number, 1); assert.equal(rows[0].exists, true);
  });

  await check('a direct edit drafts a manual change that is reviewed and saved as v3', async () => {
    const edit = await call(`/formats/${format.id}/draft-rule`, { ruleId: 'colour', area: 'visuals', text: 'Use navy blue accents.' });
    assert.equal(edit.session.id, session.id, 'goes into the open conversation');
    assert.equal(edit.proposal.rules[0].change, 'changed');
    assert.equal(edit.proposal.rules[0].evidence[0].note, 'Edited by creator');
    const v3 = await approveAll(session.id);
    assert.equal(v3.number, 3);
    assert.match(readFileSync(join(skillDir, 'rules.md'), 'utf8'), /Use navy blue accents[\s\S]*Edited by you/);
  });

  await check('rename, archive and restore rebuild the format skill; archived formats refuse new videos', async () => {
    format = (await call('/')).formats.find((f) => f.id === format.id);
    await call(`/formats/${format.id}/update`, { expected: format.revision + 1, name: 'Stale' }, 400);
    format = await call(`/formats/${format.id}/update`, { expected: format.revision, name: 'Vertical reel' });
    assert.equal(format.warning, null);
    assert.match(readFileSync(join(skillDir, 'SKILL.md'), 'utf8'), /Main YouTube › Vertical reel/);
    format = await call(`/formats/${format.id}/archive`, { expected: format.revision });
    assert.equal(existsSync(skillDir), false);
    assert.equal((await call(`/formats/${format.id}/skill`)).archived, true);
    await call('/projects', { name: 'Blocked', versionId: format.activeVersion, entry: 'idea' }, 400);
    format = await call(`/formats/${format.id}/unarchive`, { expected: format.revision });
    assert.ok(existsSync(join(skillDir, 'SKILL.md')));
    const renamed = await call(`/profiles/${profile.id}/update`, { expected: 1, name: 'Second channel' });
    assert.equal(renamed.name, 'Second channel');
    assert.match(readFileSync(join(skillDir, 'SKILL.md'), 'utf8'), /Second channel › Vertical reel/);
  });

  await check('the pinned project is untouched by rename, archive and new versions', async () => {
    const context = await request(`/api/project-context/${project.id}`);
    assert.equal(context.formatSkill.number, 1);
    assert.match(readFileSync(join(context.formatSkill.path, 'SKILL.md'), 'utf8'), /Main YouTube › Instagram reel/);
  });

  console.log(JSON.stringify({ ok: true, passed: passed.length, checks: passed }, null, 2));
} catch (e) {
  console.error(e);
  console.error(logs.slice(-4000));
  process.exitCode = 1;
} finally {
  child.kill();
  await new Promise((r) => child.exitCode !== null ? r() : child.once('exit', r));
  rmSync(root, { recursive: true, force: true });
}
