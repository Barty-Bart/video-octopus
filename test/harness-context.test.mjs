// Real adapters + manager/preferences, fake external CLIs, disposable app/studio.
//   node --test test/harness-context.test.mjs
// No real provider, credentials, model, media tool or network is used. Only the
// copied key-store dependency is replaced: its sole value is a synthetic fixture.
import test from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync, chmodSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { createHash } from 'node:crypto';
import { promisify } from 'node:util';

const SELF = fileURLToPath(import.meta.url);
const APP = resolve(dirname(SELF), '..');
const write = (path, value) => { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, value); };
const json = (path, value) => write(path, JSON.stringify(value, null, 2));
const readJSON = (path) => JSON.parse(readFileSync(path, 'utf8'));
const hash = (value) => createHash('sha256').update(value).digest('hex');

// Written as an executable module into each fake package. It records what really
// crossed stdio/argv and returns each adapter's documented wire response shape.
async function fakeCLI() {
  const { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } = await import('node:fs');
  const { join, dirname } = await import('node:path');
  const { createHash } = await import('node:crypto');
  const { createInterface } = await import('node:readline');
  const engine = process.env.OCTOPUS_TEST_ENGINE, argv = process.argv.slice(2);
  const arg = (key) => argv[argv.indexOf(key) + 1];
  const log = (item) => appendFileSync(process.env.OCTOPUS_TEST_LOG, JSON.stringify({ engine, ...item }) + '\n');
  const out = (item) => process.stdout.write(JSON.stringify(item) + '\n');
  if (argv.includes('--version')) { log({ kind: 'probe', probe: 'version' }); console.log('9.9.9 fixture'); return; }
  if (argv[0] === 'auth') { log({ kind: 'probe', probe: 'auth' }); console.log('{"loggedIn":true,"authMethod":"claude.ai","subscriptionType":"fixture"}'); return; }
  if (argv[0] === 'login') { log({ kind: 'probe', probe: 'login' }); console.log('Logged in using ChatGPT (synthetic fixture)'); return; }
  // Claude Code loads .claude/skills from the studio it runs in, or from an --add-dir folder (a pinned project's context).
  let skillRoot = engine === 'pi' ? arg('--skill') : engine === 'claude' && argv.includes('--add-dir') ? join(arg('--add-dir'), '.claude/skills') : join(process.env.OCTOPUS_TEST_STUDIO, '.claude/skills');
  const snapshot = () => Object.fromEntries(readdirSync(skillRoot).filter((name) => existsSync(join(skillRoot, name, 'SKILL.md')))
    .sort().map((name) => [name, createHash('sha256').update(readFileSync(join(skillRoot, name, 'SKILL.md'))).digest('hex')]));
  const resume = engine === 'claude' && argv.includes('--resume') ? arg('--resume') : engine === 'pi' && argv.includes('--session') ? arg('--session') : null;
  // The appended system prompt arrives as a file (Claude: --append-system-prompt-file; pi: --append-system-prompt with
  // a path). Read it as the real CLIs do, at startup; the app removes the file once the process ends.
  const promptFile = engine === 'claude' ? arg('--append-system-prompt-file') : engine === 'pi' ? arg('--append-system-prompt') : null;
  const appendPrompt = promptFile && existsSync(promptFile) ? readFileSync(promptFile, 'utf8') : null;
  const sessionFile = join(process.env.OCTOPUS_TEST_STUDIO, '.fixture-pi-session.jsonl');
  if (engine === 'pi') { mkdirSync(dirname(sessionFile), { recursive: true }); if (!existsSync(sessionFile)) writeFileSync(sessionFile, ''); }
  // The whole command line as Windows' CreateProcess would get it (each argument quoted when it holds a space or a
  // quote), which Windows caps at 32,767 characters.
  const quoteArg = (a) => /[\s"]/.test(a) ? `"${a.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/, '$1$1')}"` : a;
  const commandLine = [process.execPath, ...process.argv.slice(1)].map(quoteArg).join(' ');
  log({ kind: 'launch', argv, resume, cwd: process.cwd(), skillRoot, skills: snapshot(), promptFile, appendPrompt, commandLength: commandLine.length,
    home: process.env.HOME, local: process.env.STUDIO_LOCAL_DIR, config: process.env.CODEX_HOME,
    inheritedRealCredential: Boolean(process.env.ANTHROPIC_API_KEY || process.env.OPENAI_API_KEY || process.env.CLAUDE_CODE_OAUTH_TOKEN),
    transcription: process.env.STUDIO_TRANSCRIBE, language: process.env.STUDIO_TRANSCRIBE_LANGUAGE });
  let initialized = false;
  for await (const line of createInterface({ input: process.stdin })) {
    let m; try { m = JSON.parse(line); } catch { continue; }
    log({ kind: 'request', message: m, skills: snapshot() });
    if (engine === 'claude' && m.type === 'user') {
      if (!initialized) { initialized = true; out({ type: 'system', subtype: 'init', session_id: resume || 'fixture-claude-session', model: 'fixture-model' }); }
      out({ type: 'assistant', message: { content: [{ type: 'text', text: 'Synthetic adapter response.' }] } });
      out({ type: 'result', subtype: 'success', is_error: false, duration_ms: 1 });
    } else if (engine === 'codex' && m.id != null) {
      if (m.method === 'skills/extraRoots/set') skillRoot = m.params.extraRoots[0];
      const result = /^thread\/(start|resume)$/.test(m.method) ? { thread: { id: 'fixture-codex-thread' }, model: 'fixture-model' } : {};
      out({ id: m.id, result });
      if (m.method === 'turn/start') {
        out({ method: 'item/completed', params: { item: { type: 'agentMessage', text: 'Synthetic adapter response.' } } });
        out({ method: 'turn/completed', params: { turn: { id: 'fixture-turn', status: 'completed', durationMs: 1 } } });
      }
    } else if (engine === 'pi' && m.id != null) {
      const data = m.type === 'get_state' ? { sessionFile, sessionId: 'fixture-pi-session', model: { id: 'fixture-model', contextWindow: 128000 } } : {};
      out({ type: 'response', id: m.id, command: m.type, success: true, data });
      if (m.type === 'prompt') {
        out({ type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: 'Synthetic adapter response.' }] } });
        out({ type: 'agent_settled', aborted: false });
      }
    }
  }
}

function fixture(engine) {
  const root = mkdtempSync(join(realpathSync(tmpdir()), 'octopus-harness-context-'));
  const app = join(root, 'app'), studio = join(root, 'studio'), home = join(root, 'home'), local = join(root, 'local');
  for (const dir of [app, studio, home, local]) mkdirSync(dir);
  // Distribution sources only; never copy local/, creator projects or user config.
  for (const dir of ['server', 'core', 'starter', 'web']) cpSync(join(APP, dir), join(app, dir), { recursive: true });
  cpSync(join(APP, 'package.json'), join(app, 'package.json'));
  write(join(app, 'server/keychain.mjs'), `export const KEY_STORE = 'synthetic test fixture';
export async function readKey(name) { return name === 'DEEPGRAM_API_KEY' ? 'fixture-only-not-a-real-key' : null; }
export async function hasKey(name) { return name === 'DEEPGRAM_API_KEY'; }
export async function saveKey() { throw new Error('Fixture does not save credentials'); }
export async function removeKey() { throw new Error('Fixture does not remove credentials'); }
`);
  const packages = { claude: '@anthropic-ai/claude-code', codex: '@openai/codex', pi: '@earendil-works/pi-coding-agent' };
  const bin = join(root, 'bin');
  for (const [name, pkg] of Object.entries(packages)) {
    write(join(bin, `${name}.cmd`), 'unused npm shim fixture');
    json(join(bin, 'node_modules', pkg, 'package.json'), { type: 'module', bin: 'fixture.mjs' });
    write(join(bin, 'node_modules', pkg, 'fixture.mjs'), `(${fakeCLI.toString()})().catch((error) => { console.error(error.stack); process.exitCode = 1; });\n`);
  }
  const shell = join(root, 'fixture-shell');
  write(shell, `#!${process.execPath}\nprocess.stdout.write('__P__' + process.env.PATH + '__P__');\n`);
  chmodSync(shell, 0o700);
  write(join(root, 'deny-network.cjs'), `const {syncBuiltinESMExports}=require('node:module');
const deny=()=>{throw new Error('External/network operation forbidden in harness fixture')};
global.fetch=deny;
require('node:net').Socket.prototype.connect=deny;
require('node:dgram').createSocket=deny;
require('node:dns').lookup=deny; require('node:dns').resolve=deny;
require('node:http').request=deny; require('node:https').request=deny;
syncBuiltinESMExports();\n`);
  json(join(local, 'settings.json'), {
    studio, claudePath: join(bin, 'claude.cmd'), codexPath: join(bin, 'codex.cmd'), piPath: join(bin, 'pi.cmd'),
    permissionMode: 'manual', claude: { engine, ccSource: 'plan', codexProvider: 'chatgpt', piSource: 'pi', lean: true },
    // Synthetic key store makes this avoid all hardware/model discovery as well.
    transcribe: { engine: 'cloud', provider: 'deepgram', language: 'fr', vocab: ['FixtureWord'] },
  });
  const env = {
    PATH: bin, HOME: home, USERPROFILE: home, SHELL: shell, TMPDIR: root, TMP: root, TEMP: root,
    STUDIO_LOCAL_DIR: local, HF_HUB_CACHE: join(root, 'hf-cache'),
    CLAUDE_CONFIG_DIR: join(home, '.claude'), CODEX_HOME: join(home, '.codex'),
    OCTOPUS_TEST_ENGINE: engine, OCTOPUS_TEST_STUDIO: studio, OCTOPUS_TEST_LOG: join(root, 'wire.jsonl'),
    NODE_OPTIONS: `--require ${JSON.stringify(join(root, 'deny-network.cjs'))}`,
    ...(process.platform === 'win32' ? { SystemRoot: process.env.SystemRoot, ComSpec: process.env.ComSpec } : {}),
  };
  return { root, app, studio, home, local, shell, bin, env };
}

// About 60 KB of project context shaped like a real pinned project's: studio instructions, the approved brand, the
// pinned format's rules and examples, memories and the scene kit, with paths, quotes and non-ASCII text.
function largeProjectContext() {
  const parts = ['Project folder: projects/synthetic (type: explainer); source files: source/take-01.mov, source/take-02.mov.'];
  for (let i = 1; i <= 80; i++) {
    parts.push(`Studio instruction ${i}: Keep "lower thirds" readable — 48 px minimum, 6 s on screen; cut on breaths, never mid-word; `
      + `retime graphics after every recut and keep scene element IDs (scene-${i}-title, scene-${i}-card) stable.`);
  }
  parts.push(`Approved brand (Alpha v3): ${JSON.stringify({ colours: ['#0a2540', '#ff5a1f', '#f6f9fc'], fonts: { heading: 'Söhne Breit', body: 'Inter' }, voice: 'direct, warm, no hype' })}`);
  for (let i = 1; i <= 120; i++) {
    parts.push(`Format rule ${i} (pinned v1, cites example ex-${i % 7}): open with the result in the first ${2 + (i % 4)} s; `
      + `B-roll every ${8 + (i % 5)} s; captions sentence case; zoom 110 % on emphasis; end card at C:\\Users\\Creator\\Video Octopus\\library\\brand\\end-${i}.png.`);
  }
  for (let i = 1; i <= 160; i++) parts.push(`Memory mem-${i} (project): the creator prefers ${['short hooks', 'calm pacing', 'blue cards', 'no music under speech'][i % 4]}; evidence msg-${1000 + i}.`);
  parts.push(`Scene kit: ${JSON.stringify(Array.from({ length: 120 }, (_, i) => ({ id: `kit-${i}`, kind: ['title', 'card', 'chart', 'quote'][i % 4], file: `kit/${i}.html` })))}`);
  parts.push('LARGE-CONTEXT-MARKER: end of the synthetic project context.');
  return parts.join('\n');
}

async function worker(engine, root) {
  const app = join(root, 'app'), studio = join(root, 'studio'), local = join(root, 'local');
  const failures = [], passed = [], children = new Set(), sessions = new Set();
  const check = (name, fn) => { try { fn(); passed.push(name); } catch (error) { failures.push({ name, message: error.message }); } };
  // Intercept subprocess entry points before importing adapters. Only the fake
  // login shell and Node executing one of our fake package bins may be launched.
  const permitted = (file, args) => file === join(root, 'fixture-shell') || (file === process.execPath &&
    typeof args?.[0] === 'string' && args[0].startsWith(join(root, 'bin/node_modules') + sep) && args[0].endsWith(`${sep}fixture.mjs`));
  for (const method of ['spawn', 'execFile']) {
    const original = childProcess[method];
    childProcess[method] = (file, args, ...rest) => {
      assert.ok(permitted(file, args), `Unapproved external executable: ${file}`);
      const child = original(file, args, ...rest); children.add(child); child.once('close', () => children.delete(child)); return child;
    };
  }
  for (const method of ['exec', 'execSync', 'execFileSync', 'spawnSync', 'fork']) childProcess[method] = () => { throw new Error(`Unexpected subprocess method ${method}`); };
  syncBuiltinESMExports();
  const imp = (name) => import(pathToFileURL(join(app, 'server', `${name}.mjs`)).href);
  const manager = await imp('managed-skills'), util = await imp('util'), maintenance = await imp('maintenance');
  const { ChatSession } = await imp('claude'), { CodexSession } = await imp('codex'), { PiSession } = await imp('pi');
  const Klass = { claude: ChatSession, codex: CodexSession, pi: PiSession }[engine];
  const prefs = join(studio, 'preferences/skills.json'), id = `fixture-${engine}`, project = join(studio, 'projects/synthetic');
  mkdirSync(project, { recursive: true });
  write(join(studio, 'BRAND.md'), 'Synthetic preference prose: blue cards and simple labels.');
  json(prefs, { schema: 1, presentation: { tone: 'direct', pacing: 'calm' }, skills: { 'octopus.transcribe': { language: 'pl' } } });
  manager.syncSkills({ studio, fresh: true });
  const custom = join(studio, 'skills/custom/synthetic-motion/SKILL.md');
  write(custom, '---\nname: synthetic-motion\ndescription: Synthetic custom fixture\n---\n\nCUSTOM-FIRST\n');
  manager.syncSkills({ studio, action: {action: 'refresh'} });
  const customId = manager.skillsView({ studio }).items.find((x) => x.name === 'synthetic-motion').id;
  const wire = () => existsSync(process.env.OCTOPUS_TEST_LOG) ? readFileSync(process.env.OCTOPUS_TEST_LOG, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) : [];
  const launch = () => wire().filter((x) => x.kind === 'launch').at(-1);
  const turn = () => wire().filter((x) => x.kind === 'request' && (engine === 'claude' ? x.message.type === 'user' : engine === 'codex' ? x.message.method === 'turn/start' : x.message.type === 'prompt')).at(-1);
  const textOf = (row = turn()) => engine === 'claude' ? row.message.message.content : engine === 'codex' ? row.message.params.input[0].text : row.message.message;
  const initialPrompt = () => {
    if (engine === 'codex') return wire().filter((x) => /^thread\/(start|resume)$/.test(x.message?.method)).at(-1).message.params.developerInstructions;
    return launch().appendPrompt;
  };
  const inventory = (text) => JSON.parse(/Active skills: (\[.*?\])\. Disabled skills:/.exec(text)?.[1] || '[]');
  const create = () => { const s = new Klass(id, () => 'Synthetic project instructions.'); s.cwd = () => project; sessions.add(s); return s; };
  const send = async (session, text) => {
    let timer, listener;
    const done = new Promise((resolve, reject) => {
      timer = setTimeout(() => reject(new Error(`Timed out waiting for ${engine}: ${text}`)), 6000);
      listener = (event) => { if (event.t === 'result') resolve(event); if (event.t === 'error') reject(new Error(event.text)); };
      session.listeners.add(listener);
    });
    // Attach a rejection handler before send, whose response may be synchronous.
    done.catch(() => {});
    try { await session.send(text); const result = await done; assert.equal(result.ok, true); }
    finally { clearTimeout(timer); session.listeners.delete(listener); }
  };
  const stop = async (session) => {
    const p = session.proc; if (!p) return;
    const closed = new Promise((resolve) => p.once('close', resolve)); session.kill(); await closed;
  };
  const action = (action, skillId = 'octopus.transcribe', extra = {}) => manager.syncSkills({ studio,
    action: { action, id: skillId, revision: manager.skillsView({ studio }).revision, ...extra } });
  try {
    let s = create();
    await send(s, 'FIRST');
    check('startup sends resolved preferences, prose and explicit app settings', () => {
      assert.match(initialPrompt(), /VIDEO OCTOPUS CREATOR PREFERENCES/);
      assert.match(initialPrompt(), /"pacing":"calm"/);
      assert.match(initialPrompt(), /Synthetic preference prose/);
      assert.match(initialPrompt(), /Transcription language: French/);
      assert.match(initialPrompt(), /Explicit app Settings.*take precedence/);
      assert.equal(launch().language, 'fr');
    });
    check('startup exposes six core skills plus exactly one custom skill', () => {
      assert.equal(Object.keys(launch().skills).length, 7);
      assert.ok(launch().skills['transcribe']); assert.ok(launch().skills['synthetic-motion']);
      assert.equal(launch().skillRoot, join(studio, '.claude/skills'));
      if (engine === 'codex') assert.deepEqual(wire().find((x) => x.message?.method === 'skills/extraRoots/set').message.params.extraRoots, [join(studio, '.claude/skills')]);
      if (engine === 'pi') assert.equal(launch().argv.filter((x) => x === '--skill').length, 1);
      if (engine === 'claude') assert.ok(launch().argv.includes('--strict-mcp-config'));
      assert.equal(inventory(initialPrompt()).filter((x) => x.selection === 'core').length, 6);
      assert.equal(inventory(initialPrompt()).filter((x) => x.selection === 'custom').length, 1);
    });
    check('fake child receives only isolated home/settings and no real credential', () => {
      assert.equal(launch().home, join(root, 'home')); assert.equal(launch().local, local);
      assert.equal(launch().config, join(root, 'home/.codex')); assert.equal(launch().cwd, project);
      assert.equal(launch().inheritedRealCredential, false);
    });
    await send(s, 'UNCHANGED');
    check('unchanged turn avoids duplicate context', () => assert.equal(textOf(), 'UNCHANGED'));
    json(prefs, { schema: 1, presentation: { pacing: 'brisk' } });
    await send(s, 'PREFERENCE-CHANGED');
    check('running turn refreshes changed preferences', () => { assert.match(textOf(), /updated instructions/i); assert.match(textOf(), /"pacing":"brisk"/); });
    await send(s, 'UNCHANGED-AGAIN');
    check('updated context is not repeated on the next unchanged turn', () => assert.equal(textOf(), 'UNCHANGED-AGAIN'));
    write(prefs, '{INVALID'); await send(s, 'PREFERENCE-INVALID');
    check('invalid preferences deliver diagnostic without preventing repair chat', () => {
      assert.match(textOf(), /Preference status: invalid/); assert.match(textOf(), /Invalid JSON/); assert.match(textOf(), /FALLBACK DEFAULTS ONLY/);
    });
    await stop(s);
    json(prefs, { schema: 1, presentation: { tone: 'formal' } });
    s = create(); await send(s, 'RESUMED-PREFERENCE');
    check('resume uses saved session and refreshes preferences on first resumed turn', () => {
      assert.equal(s.resumed, true); assert.match(textOf(), /"tone":"formal"/);
      assert.match(initialPrompt(), /"tone":"formal"/);
      if (engine === 'claude') assert.equal(launch().resume, 'fixture-claude-session');
      if (engine === 'codex') assert.ok(wire().some((x) => x.message?.method === 'thread/resume'));
      if (engine === 'pi') assert.equal(launch().resume, join(studio, '.fixture-pi-session.jsonl'));
    });
    action('customize');
    const fork = join(studio, 'skills/overrides/octopus.transcribe/SKILL.md');
    write(fork, readFileSync(fork, 'utf8') + '\nFORK-PRESENTATION-FIXTURE\n'); manager.syncSkills({ studio, action: {action: 'refresh'} });
    await send(s, 'SELECTED-FORK');
    check('compatible fork is the sole published version', () => assert.equal(turn().skills.transcribe, hash(readFileSync(fork))));
    check('core to compatible fork refreshes running context', () => assert.notEqual(textOf(), 'SELECTED-FORK'));
    await stop(s);
    write(fork, readFileSync(fork, 'utf8') + '\nFORK-SECOND\n'); manager.syncSkills({ studio, action: {action: 'refresh'} });
    s = create(); await send(s, 'RESUME-FORK-EDIT');
    check('resumed compatible fork edit refreshes startup and first resumed turn', () => {
      assert.equal(s.resumed, true); assert.notEqual(textOf(), 'RESUME-FORK-EDIT');
      assert.equal(inventory(initialPrompt()).find((x) => x.id === 'octopus.transcribe').selection, 'fork');
      assert.match(textOf(), /discard cached instructions/);
    });
    action('latest'); await send(s, 'SELECTED-CORE');
    check('core selection preserves saved fork and publishes core', () => {
      assert.equal(turn().skills.transcribe, hash(readFileSync(join(app, 'starter/.claude/skills/transcribe/SKILL.md'))));
      assert.match(readFileSync(fork, 'utf8'), /FORK-PRESENTATION-FIXTURE/);
    });
    check('compatible fork to core refreshes running context', () => assert.notEqual(textOf(), 'SELECTED-CORE'));
    write(custom, readFileSync(custom, 'utf8') + '\nCUSTOM-SECOND\n'); manager.syncSkills({ studio, action: {action: 'refresh'} });
    await send(s, 'CUSTOM-EDITED');
    check('custom source edit refreshes context and active publication', () => {
      assert.equal(turn().skills['synthetic-motion'], hash(readFileSync(custom))); assert.notEqual(textOf(), 'CUSTOM-EDITED');
    });
    manager.syncSkills({ studio, action: {action: 'refresh'} }); await send(s, 'SKILLS-UNCHANGED');
    check('unchanged skill refresh does not duplicate context', () => assert.equal(textOf(), 'SKILLS-UNCHANGED'));
    action('disable', customId); await send(s, 'CUSTOM-DISABLED');
    check('disabled custom workflow is absent and context is refreshed', () => { assert.equal(turn().skills['synthetic-motion'], undefined); assert.notEqual(textOf(), 'CUSTOM-DISABLED'); });
    action('use-custom');
    const catalogPath = join(app, 'core/skills.json'), catalog = readJSON(catalogPath); catalog.apiVersion += 1; json(catalogPath, catalog);
    manager.syncSkills({ studio, action: {action: 'refresh'} }); await send(s, 'API-CHANGED');
    check('incompatible selected fork is withheld but repair chat continues with diagnostic', () => {
      assert.equal(turn().skills.transcribe, undefined); assert.match(textOf(), /Unavailable selected custom workflows: transcribe/);
      assert.match(textOf(), /do not run those workflows/); assert.ok(existsSync(fork));
      assert.equal(inventory(textOf()).some((x) => x.id === 'octopus.transcribe'), false);
    });
    await stop(s); s = create(); await send(s, 'RESUME-BLOCKED');
    check('resumed startup also withholds incompatible fork', () => { assert.equal(s.resumed, true); assert.equal(launch().skills.transcribe, undefined); assert.match(initialPrompt(), /Unavailable selected custom workflows: transcribe/); });
    const before = new Set(manager.skillsView({ studio }).backups.map((b) => b.id));
    const latest = action('latest');
    const backup = latest.backups.find((b) => !before.has(b.id));
    action('restore', undefined, { backup: backup.id });
    await send(s, 'RESTORED-HELD');
    check('held compatible snapshot permits repair chat and prevents skill mutation', () => {
      assert.equal(manager.skillsView({ studio }).held, true);
      assert.throws(() => action('latest'), /held.*Resume updates/);
      assert.equal(turn().skills.transcribe, undefined);
    });
    check('restoring held snapshot refreshes its inventory and hold diagnostic', () => {
      assert.match(textOf(), /restored skill snapshot is held/);
      assert.equal(inventory(textOf()).some((x) => x.id === 'octopus.transcribe'), false);
    });
    action('refresh'); action('latest');
    maintenance.beginMaintenance('Fixture update in progress.');
    const requestCount = wire().filter((x) => x.kind === 'request').length;
    try {
      await assert.rejects(() => s.send('MUST-NOT-SEND'), /New work is paused/);
      check('maintenance refuses a turn before any CLI input', () => assert.equal(wire().filter((x) => x.kind === 'request').length, requestCount));
    } finally { maintenance.endMaintenance(); }
    await send(s, 'AFTER-MAINTENANCE');
    check('chat resumes after maintenance with current core', () => assert.ok(turn().skills.transcribe));
    // A pinned project: the adapter must hand the agent the project's own skill root (its pinned format skill copy)
    // and the pinned context text, for every harness.
    const pinnedRoot = join(project, '.octopus/context/.claude/skills');
    write(join(pinnedRoot, 'format-abcdef12/SKILL.md'), '---\nname: format-abcdef12\ndescription: Pinned synthetic format v1\n---\nPINNED-FORMAT-V1\n');
    const pinned = new Klass(`${id}-pinned`, () => 'Synthetic pinned project instructions.');
    pinned.cwd = () => project; sessions.add(pinned);
    pinned.projectScope = () => ({ skillRoot: pinnedRoot, instructionRoot: studio, text: 'PINNED-PROJECT-CONTEXT: format v1 is authoritative for this project.' });
    await send(pinned, 'PINNED-PROJECT');
    check('pinned project receives its own skill root with the pinned format skill and context', () => {
      // Codex is given its roots after launch, so check what the agent could see during the turn.
      if (engine !== 'codex') assert.equal(launch().skillRoot, pinnedRoot);
      assert.equal(turn().skills['format-abcdef12'], hash(readFileSync(join(pinnedRoot, 'format-abcdef12/SKILL.md'))));
      assert.equal(turn().skills.transcribe, undefined, 'the studio-wide publication is not this project\'s skill root');
      assert.match(initialPrompt(), /PINNED-PROJECT-CONTEXT: format v1 is authoritative/);
      if (engine === 'claude') assert.equal(launch().argv[launch().argv.indexOf('--add-dir') + 1], join(project, '.octopus/context'));
      if (engine === 'codex') assert.deepEqual(wire().filter((x) => x.message?.method === 'skills/extraRoots/set').at(-1).message.params.extraRoots, [pinnedRoot]);
      if (engine === 'pi') assert.equal(launch().argv[launch().argv.indexOf('--skill') + 1], pinnedRoot);
    });
    await stop(pinned);
    // A large, realistic project context (about 60 KB: instructions, brand, format rules, memories, the scene kit),
    // more than the ~43 KB a real pinned project sends. Windows caps the command line at 32,767 characters, so the
    // context must not travel on it: each engine's spawned command line stays under 30,000 characters.
    const large = largeProjectContext();
    const big = new Klass(`${id}-large`, () => large);
    big.cwd = () => project; sessions.add(big);
    big.projectScope = () => ({ skillRoot: pinnedRoot, instructionRoot: studio, text: 'PINNED-PROJECT-CONTEXT: large fixture.' });
    await send(big, 'LARGE-CONTEXT');
    const bigLaunch = launch();
    check('a large project context keeps the spawned command line under 30,000 characters', () => {
      assert.ok(large.length > 55000, `fixture context is only ${large.length} characters`);
      assert.ok(bigLaunch.commandLength < 30000, `${engine} command line is ${bigLaunch.commandLength} characters`);
      assert.ok(initialPrompt().includes(large.slice(-2000)), 'the whole context still reaches the agent');
      if (engine !== 'codex') {
        assert.ok(bigLaunch.argv.every((a) => !a.includes('LARGE-CONTEXT-MARKER')), 'no context on the command line');
        assert.equal(dirname(bigLaunch.promptFile), join(local, 'agent-prompts'), 'the prompt file is in the app\'s own local folder');
        assert.ok(existsSync(bigLaunch.promptFile), 'the prompt file stays while its agent runs');
        if (process.platform !== 'win32') assert.equal(statSync(bigLaunch.promptFile).mode & 0o777, 0o600);
      }
    });
    await stop(big);
    if (engine !== 'codex') check('the prompt file is removed when its agent process ends', () => {
      assert.equal(existsSync(bigLaunch.promptFile), false);
      const running = [...sessions].filter((x) => x.proc).length;
      assert.ok(readdirSync(join(local, 'agent-prompts')).length <= running, 'only running agents keep a prompt file');
    });
    // Direct active-copy tampering is rejected before the agent sees another turn.
    write(join(studio, '.claude/skills/transcribe/SKILL.md'), 'unexpected tampering');
    await assert.rejects(() => s.send('MUST-NOT-USE-TAMPERED'), /Skill files changed/);
    passed.push('tampered publication refuses a turn before agent execution');
    check('persistent adapter state remains in disposable local folder', () => assert.ok(util.state().projects[id].sessionId));
    return { engine, passed: passed.length, checks: passed, failures, largeContext: large.length, largeCommandLine: bigLaunch.commandLength, launches: wire().filter((x) => x.kind === 'launch').length,
      turns: wire().filter((x) => x.kind === 'request' && (x.message.type === 'user' || x.message.method === 'turn/start' || x.message.type === 'prompt')).length,
      sourceHashes: Object.fromEntries(['claude', 'codex', 'pi', 'managed-skills', 'skill-preferences'].map((name) => [name, hash(readFileSync(join(app, 'server', `${name}.mjs`)))])) };
  } finally {
    for (const s of sessions) await stop(s);
    for (const p of children) p.kill();
  }
}

// GitHub's Windows runners are much slower at spawning processes; give each engine worker more time there.
const WORKER_MS = process.platform === 'win32' ? 120000 : 35000;

if (process.argv[2] === '--harness-worker') {
  worker(process.argv[3], process.argv[4]).then((result) => console.log(JSON.stringify(result)), (error) => { console.error(error.stack); process.exitCode = 1; });
} else {
  for (const engine of ['claude', 'codex', 'pi']) test(`${engine}: real adapter context and skill lifecycle over fake CLI`, { timeout: WORKER_MS + 10000 }, async (t) => {
    const f = fixture(engine);
    try {
      const { stdout, stderr } = await promisify(childProcess.execFile)(process.execPath, [SELF, '--harness-worker', engine, f.root],
        { cwd: f.app, env: f.env, timeout: WORKER_MS, maxBuffer: 2 * 1024 * 1024 });
      // Node 22 (the oldest supported) still marks node:sqlite experimental and says so once on stderr; nothing else may be there.
      assert.equal(stderr.replace(/^\(node:\d+\) ExperimentalWarning: SQLite is an experimental feature.*\n(\(Use `node --trace-warnings.*\n)?/m, ''), '');
      const result = JSON.parse(stdout.trim());
      t.diagnostic(JSON.stringify(result));
      assert.deepEqual(result.failures, [], `${engine} failed ${result.failures.length} integration checks`);
      assert.ok(result.passed >= 26);
    } finally { rmSync(f.root, { recursive: true, force: true }); }
  });
}
