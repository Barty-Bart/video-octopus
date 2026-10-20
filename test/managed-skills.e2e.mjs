// Self-contained integration test: real browser/UI, disposable app/studio and local-only Git updates.
// PLAYWRIGHT_PATH=/absolute/path/to/playwright node test/managed-skills.e2e.mjs
// No real agents, credentials, creator studios, external network, installers or model downloads.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createServer } from 'node:net';
import { mkdtempSync, mkdirSync, cpSync, writeFileSync, readFileSync, existsSync, realpathSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_PATH || 'playwright');
const source = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const root = realpathSync(mkdtempSync(join(tmpdir(), 'octopus-skills-e2e-')));
const app = join(root, 'app'), release = join(root, 'release'), origin = join(root, 'origin.git');
const studio = join(root, 'studio'), local = join(root, 'local'), home = join(root, 'home'), bin = join(root, 'bin');
const evidence = { suite: 'managed-skills e2e', at: new Date().toISOString(), node: process.version, platform: process.platform, arch: process.arch, checks: [], errors: [] };
const began = Date.now();
const checks = evidence.checks;
let browser, launcher, serverLog = '', success = false;
const put = (p, s) => { mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, s); };
const json = (p) => JSON.parse(readFileSync(p, 'utf8'));
const putJSON = (p, data) => put(p, `${JSON.stringify(data, null, 2)}\n`);
const text = (p) => readFileSync(p, 'utf8');
const delay = (ms) => new Promise((done) => setTimeout(done, ms));
const mark = (name) => { checks.push(name); console.log(`[managed-skills e2e] PASS ${name}`); };
async function until(fn, message, ms = 20000) {
  const end = Date.now() + ms;
  let last;
  while (Date.now() < end) { try { const value = await fn(); if (value) return value; } catch (e) { last = e; } await delay(150); }
  throw new Error(`${message}${last ? `: ${last.message}` : ''}`);
}
const port = await new Promise((done, fail) => {
  const s = createServer(); s.once('error', fail); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => done(p)); });
});
const base = `http://127.0.0.1:${port}`;
const fixturePath = [bin, dirname(process.execPath), '/usr/bin', '/bin', '/usr/sbin', '/sbin'].join(':');
const env = {
  HOME: home, USERPROFILE: home, TMPDIR: root, PATH: fixturePath, SHELL: join(bin, 'fixture-shell'),
  XDG_CONFIG_HOME: join(home, '.config'), XDG_CACHE_HOME: join(home, '.cache'), XDG_DATA_HOME: join(home, '.local/share'),
  CODEX_HOME: join(home, '.codex'), CLAUDE_CONFIG_DIR: join(home, '.claude'), PI_CODING_AGENT_DIR: join(home, '.pi'),
  HF_HOME: join(home, '.cache/huggingface'), HF_HUB_OFFLINE: '1', TRANSFORMERS_OFFLINE: '1',
  STUDIO_LOCAL_DIR: local, STUDIO_NO_OPEN: '1', STUDIO_NO_SCHEDULES: '1', PORT: String(port),
  STUDIO_KEYCHAIN_SERVICE: `Video-Octopus-integration-${process.pid}-${Date.now()}`,
  GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never',
  GIT_ALLOW_PROTOCOL: 'file', GIT_AUTHOR_NAME: 'Synthetic Test', GIT_AUTHOR_EMAIL: 'test@example.invalid',
  GIT_COMMITTER_NAME: 'Synthetic Test', GIT_COMMITTER_EMAIL: 'test@example.invalid', LC_ALL: 'C',
};
const git = (dir, ...args) => execFileSync('/usr/bin/git', ['-C', dir, ...args], { env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const skillPath = (name) => join(studio, '.claude', 'skills', name, 'SKILL.md');
const forkPath = join(studio, 'skills', 'overrides', 'octopus.rough-cut', 'SKILL.md');
const preferencePath = join(studio, 'preferences', 'skills.json');
const preferenceBytes = '{\n  "schema": 1,\n  "presentation": { "pacing": "calm", "tone": "direct" }\n}\n';
const customBytes = '---\nname: fixture-personal\ndescription: Synthetic independent workflow\n---\n# Personal fixture\nPreserve these exact bytes.\n';
const privateBytes = 'Synthetic private project; never part of app update.\n';
async function api(path = '/api/app/updates', data) {
  const r = await fetch(base + path, data === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Studio': '1' }, body: JSON.stringify(data) });
  const body = await r.json();
  assert(r.ok, `API ${path}: ${JSON.stringify(body)}`);
  return body;
}
const item = (view, id = 'octopus.rough-cut') => view.skills.items.find((i) => i.id === id);
function preserved() {
  assert.equal(text(preferencePath), preferenceBytes);
  assert.equal(text(join(studio, 'skills/custom/fixture-personal/SKILL.md')), customBytes);
  assert.equal(text(join(studio, 'projects/fixture/private.txt')), privateBytes);
  assert.equal(text(join(studio, 'BRAND.md')), 'Synthetic creator brand notes.\n');
}
async function shutdown() {
  if (!launcher) return;
  const proc = launcher;
  // Only the exact launcher and server started by this fixture are stopped.
  let pid;
  try { pid = json(join(local, 'server.json')).pid; } catch {}
  if (Number.isInteger(pid) && pid > 1) { try { process.kill(pid, 'SIGTERM'); } catch {} }
  await until(() => proc.exitCode !== null || proc.signalCode !== null, 'Fixture launcher did not exit', 5000).catch(() => { proc.kill('SIGTERM'); });
  launcher = null;
}
try {
  for (const p of [release, studio, local, home, bin]) mkdirSync(p, { recursive: true });
  put(join(bin, 'fixture-shell'), `#!/bin/sh\nprintf '__P__%s__P__' '${fixturePath}'\n`);
  chmodSync(join(bin, 'fixture-shell'), 0o755);
  for (const name of ['claude', 'codex', 'pi', 'lms', 'ollama']) {
    put(join(bin, name), '#!/bin/sh\nexit 1\n'); chmodSync(join(bin, name), 0o755);
  }
  // Snapshot only the runtime distribution, never local state, Git internals or private handoffs.
  const runtimePaths = ['server', 'web', 'core', 'starter', 'bin', 'package.json', 'start.sh', 'start.cmd', '.gitignore'];
  for (const p of runtimePaths) cpSync(join(source, p), join(release, p), { recursive: true, dereference: false });
  const originalHead = git(source, 'rev-parse', 'HEAD');
  git(release, 'init', '-b', 'main'); git(release, 'add', '.'); git(release, 'commit', '-qm', 'Synthetic current runtime snapshot');
  evidence.sourceBase = originalHead;
  evidence.runtimeTree = git(release, 'rev-parse', 'HEAD^{tree}');
  git(root, 'init', '--bare', origin); git(release, 'remote', 'add', 'origin', origin); git(release, 'push', '-qu', 'origin', 'main');
  git(root, 'clone', '--quiet', '--branch', 'main', origin, app);
  // Refuse accidental non-loopback Node traffic as well as non-file Git transports.
  const guard = join(root, 'network-guard.mjs');
  put(guard, `import net from 'node:net';\nimport tls from 'node:tls';\nimport { syncBuiltinESMExports } from 'node:module';\nconst allow = new Set(['127.0.0.1','localhost','::1']);\nfunction check(args) { const a=args[0]; const h=typeof a==='object' ? a.hostname||a.host : typeof args[1]==='string' ? args[1] : undefined; if (h && !allow.has(h)) throw new Error('Fixture blocked remote connection'); }\nfor (const [obj,key] of [[net,'connect'],[net,'createConnection'],[tls,'connect']]) { const fn=obj[key]; obj[key]=function(...args) { check(args); return fn.apply(this,args); }; }\nconst f=globalThis.fetch; globalThis.fetch=(url,...args)=>{ const u=new URL(typeof url==='string'||url instanceof URL?url:url.url); if (!allow.has(u.hostname)) throw new Error('Fixture blocked remote fetch'); return f(url,...args); };\nsyncBuiltinESMExports();\n`);
  env.NODE_OPTIONS = `--import=${guard}`;
  putJSON(join(local, 'settings.json'), { studio, setup: { done: true, agent: '' }, updates: { auto: false }, scheduleCatchUp: false,
    claude: { engine: 'claude', lean: true, useApiKey: false }, help: { stepsIntro: 'dismissed' },
    ...Object.fromEntries(['claude', 'codex', 'pi', 'lms', 'ollama'].map((n) => [`${n}Path`, join(bin, n)])),
  });
  putJSON(join(local, 'schedules.json'), { v: 1, schedules: [] });
  execFileSync(process.execPath, ['--input-type=module', '-e',
    "import { pathToFileURL } from 'node:url'; const { createStudio } = await import(pathToFileURL(process.argv[1])); createStudio(process.argv[2], { use: false });",
    join(app, 'server/starter.mjs'), studio], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  put(preferencePath, preferenceBytes);
  put(join(studio, 'skills/custom/fixture-personal/SKILL.md'), customBytes);
  put(join(studio, 'projects/fixture/private.txt'), privateBytes);
  put(join(studio, 'BRAND.md'), 'Synthetic creator brand notes.\n');
  launcher = spawn('/bin/bash', [join(app, 'start.sh')], { cwd: app, env, stdio: ['ignore', 'pipe', 'pipe'] });
  launcher.stdout.on('data', (b) => { serverLog += b; }); launcher.stderr.on('data', (b) => { serverLog += b; });
  await until(async () => (await api()).skills.ok, 'Fixture server did not become ready');
  browser = await chromium.launch({ headless: true, env: { ...env, NODE_OPTIONS: '' }, ...(process.env.PLAYWRIGHT_EXECUTABLE_PATH ? { executablePath: process.env.PLAYWRIGHT_EXECUTABLE_PATH } : {}) });
  evidence.browser = browser.version();
  const page = await browser.newPage({ viewport: { width: 1440, height: 1100 } });
  page.setDefaultTimeout(10000);
  const pageErrors = [], blockedRequests = [];
  page.on('pageerror', (e) => pageErrors.push(e.message));
  await page.route('**/*', (route) => {
    if (new URL(route.request().url()).origin === base) return route.continue();
    blockedRequests.push(route.request().url()); return route.abort();
  });
  const row = (name) => page.locator('.set-row').filter({ has: page.locator('.set-l > b', { hasText: new RegExp(`^${name}$`) }) });
  const open = async () => {
    // A distinct query forces a document load; repeating only the hash can keep stale DOM during restart.
    await page.goto(`${base}/?fixture=${Date.now()}#/settings/updates`);
    await page.getByRole('button', { name: 'Refresh skills', exact: true }).waitFor();
  };
  const skillClick = async (label, { name, confirm = false } = {}) => {
    const button = (name ? row(name) : page).getByRole('button', { name: label, exact: true }).first();
    const response = page.waitForResponse((r) => r.url() === `${base}/api/app/updates/skills` && r.request().method() === 'POST');
    response.catch(() => {}); // Attach immediately so a click timeout still reaches fixture cleanup.
    await button.click();
    if (confirm) await page.locator('.cf-modal [data-a=ok]').click();
    const result = await (await response).json();
    assert.notEqual(result.ok, false, JSON.stringify(result)); assert(!result.error, JSON.stringify(result));
    await until(async () => !(await page.locator('.cf-modal').count()) && await page.getByRole('button', { name: /^(Refresh skills|Resume skill updates)$/ }).isEnabled(), 'UI did not settle');
    return api();
  };
  await open();
  let view = await api();
  assert.equal(view.auto, false); assert.equal(view.skills.items.filter((x) => x.mode === 'default').length, 6);
  assert(view.skills.items.filter((x) => x.mode === 'default').every((x) => !x.disabled && existsSync(skillPath(x.name))));
  assert.equal(view.skills.items.filter((x) => x.mode === 'custom').length, 1);
  assert.equal(item(view).mode, 'default'); assert.equal(view.preferences.status, 'valid');
  assert.match(await row('rough-cut').innerText(), /Core selected/);
  mark('fresh app publishes six core skills and one independent skill');

  await skillClick('Make a custom version…', { name: 'rough-cut', confirm: true });
  assert.equal(item(await api()).mode, 'override');
  const forkOne = text(forkPath) + '\nSynthetic creator workflow A.\n'; put(forkPath, forkOne);
  await skillClick('Refresh skills'); assert.equal(text(skillPath('rough-cut')), forkOne);
  await skillClick('Use latest core', { name: 'rough-cut', confirm: true });
  assert.equal(item(await api()).mode, 'default'); assert.equal(text(forkPath), forkOne);
  assert.notEqual(text(skillPath('rough-cut')), forkOne);
  assert.match(await row('rough-cut').innerText(), /Your saved version:/);
  const forkTwo = forkOne + 'Inactive custom edit B.\n'; put(forkPath, forkTwo);
  await skillClick('Refresh skills'); assert.equal(item(await api()).mode, 'default');
  assert.notEqual(text(skillPath('rough-cut')), forkTwo);
  await skillClick('Use my custom version', { name: 'rough-cut' });
  assert.equal(text(skillPath('rough-cut')), forkTwo);
  await skillClick('Compare with core', { name: 'rough-cut' });
  await row('Compare versions').locator('details').first().locator('summary').click();
  assert.match(await row('Compare versions').innerText(), /Your version/);
  assert.match(await row('Compare versions').innerText(), /Synthetic creator workflow A/);
  await page.getByRole('button', { name: 'Close comparison', exact: true }).click();
  await skillClick('Disable', { name: 'join-check' });
  assert(!existsSync(skillPath('join-check'))); preserved();
  mark('customize, compare, core switch, inactive fork edits and explicit reselection preserve bytes');

  put(preferencePath, '{ invalid json\n'); await skillClick('Refresh skills');
  assert.equal((await api()).preferences.status, 'invalid');
  await page.getByText('Preferences need attention', { exact: true }).waitFor();
  put(preferencePath, preferenceBytes); await skillClick('Refresh skills');
  assert.equal((await api()).preferences.status, 'valid');
  await page.getByText('Your skill options are valid', { exact: true }).waitFor();
  mark('invalid preference diagnostics refresh immediately after repair');

  async function releaseUpdate(label, change) {
    change(); git(release, 'add', '.'); git(release, 'commit', '-qm', label); git(release, 'push', '-q', 'origin', 'main');
    const before = await api();
    const check = page.waitForResponse((r) => r.url().endsWith('/api/app/updates/check') && r.request().method() === 'POST');
    await page.getByRole('button', { name: 'Check for updates', exact: true }).click(); await check;
    await page.getByRole('button', { name: 'Update app and skills', exact: true }).waitFor();
    const pull = page.waitForResponse((r) => r.url().endsWith('/api/app/updates/pull') && r.request().method() === 'POST');
    await page.getByRole('button', { name: 'Update app and skills', exact: true }).click();
    const result = await (await pull).json(); assert.equal(result.updated, true, JSON.stringify(result)); assert.equal(result.restarting, true);
    await until(async () => { const v = await api(); return v.bootId !== before.bootId && v.skills.ok && !v.restart.needed; }, 'Updated server did not restart', 30000);
    await page.waitForLoadState('domcontentloaded');
    await open();
    preserved(); assert.equal(text(forkPath), forkTwo);
    return api();
  }
  view = await releaseUpdate('Synthetic compatible feature release', () => {
    const catalog = json(join(release, 'core/skills.json'));
    for (const name of ['rough-cut', 'transcribe']) {
      catalog.skills.find((s) => s.name === name).version = '1.2.0';
      const p = join(release, 'starter/.claude/skills', name, 'SKILL.md'); put(p, text(p) + `\nSynthetic release addition for ${name}.\n`);
    }
    catalog.skills.push({ id: 'octopus.fixture-added', name: 'fixture-added', version: '1.0.0', path: 'starter/.claude/skills/fixture-added', legacyNames: [] });
    put(join(release, 'starter/.claude/skills/fixture-added/SKILL.md'), '---\nname: fixture-added\ndescription: Synthetic new feature\n---\n# Added core workflow\n');
    putJSON(join(release, 'core/skills.json'), catalog);
    put(join(release, 'starter/preferences/skills.json'), '{"schema":1,"presentation":{"pacing":"brisk"}}\n');
  });
  assert.equal(item(view).mode, 'override'); assert.equal(item(view).forkVersion, '1.1.0');
  assert.equal(item(view).availableVersion, '1.2.0'); assert.equal(text(skillPath('rough-cut')), forkTwo);
  assert.match(text(skillPath('transcribe')), /Synthetic release addition/);
  assert(existsSync(skillPath('fixture-added'))); assert(!existsSync(skillPath('join-check')));
  await skillClick('Keep my version', { name: 'rough-cut' }); assert.equal(item(await api()).pending, false);
  mark('local Git update adds core skill, updates defaults, preserves selected fork/preferences and restarts through start.sh');

  view = await releaseUpdate('Synthetic breaking API release', () => {
    const catalog = json(join(release, 'core/skills.json')); catalog.apiVersion += 1; putJSON(join(release, 'core/skills.json'), catalog);
  });
  assert.equal(item(view).compatibilityBlocked, true); assert.equal(item(view).mode, 'override');
  assert(!existsSync(skillPath('rough-cut'))); assert(existsSync(skillPath('transcribe')));
  assert.match(await row('rough-cut').innerText(), /Paused for review/);
  assert.equal(await row('rough-cut').getByRole('button', { name: 'Keep my version', exact: true }).count(), 0);
  await skillClick('Use latest core', { name: 'rough-cut', confirm: true });
  assert.equal(item(await api()).mode, 'default'); assert.equal(text(forkPath), forkTwo);
  assert.match(await row('rough-cut').innerText(), /Core remains selected/);
  await skillClick('I reviewed compatibility…', { name: 'rough-cut', confirm: true });
  assert.equal(item(await api()).mode, 'default');
  await skillClick('Use my custom version', { name: 'rough-cut' });
  assert.equal(text(skillPath('rough-cut')), forkTwo);
  mark('breaking API pauses only affected fork; review does not silently select inactive saved version');

  const priorBoot = (await api()).bootId;
  const restarted = await api('/api/app/updates/restart', {}); assert.equal(restarted.restarting, true);
  await until(async () => (await api()).bootId !== priorBoot, 'Explicit restart did not complete');
  await open(); assert.equal(item(await api()).mode, 'override'); assert.equal(text(skillPath('rough-cut')), forkTwo); preserved();
  mark('explicit supervised restart retains selected fork and creator data');

  await skillClick('Disable', { name: 'transcribe' });
  await skillClick('Enable', { name: 'transcribe' });
  assert.equal(item(await api(), 'octopus.transcribe').disabled, false);
  await skillClick('Restore backup', { name: 'Recovery', confirm: true });
  view = await api(); assert.equal(view.skills.held, true);
  assert.equal(item(view, 'octopus.transcribe').disabled, true);
  assert(await row('rough-cut').getByRole('button', { name: 'Use latest core', exact: true }).isDisabled());
  await skillClick('Resume skill updates');
  assert.equal((await api()).skills.held, false); assert.equal(item(await api(), 'octopus.transcribe').disabled, true);
  assert.equal(text(forkPath), forkTwo); preserved();
  mark('UI backup restore holds updates, disables selection changes and resumes without losing creator data');

  // A release that requires a new runtime is left for a manual update; it cannot half-activate skills.
  const stable = await api(), stableHead = git(app, 'rev-parse', 'HEAD');
  const packagePath = join(release, 'package.json'), nextPackage = json(packagePath);
  nextPackage.engines = { node: '>=99' }; putJSON(packagePath, nextPackage);
  git(release, 'add', 'package.json'); git(release, 'commit', '-qm', 'Synthetic runtime requirements change'); git(release, 'push', '-q', 'origin', 'main');
  const localPackage = join(app, 'package.json'), priorPackage = text(localPackage);
  put(localPackage, priorPackage + '\n');
  async function checkFromUI() {
    const response = page.waitForResponse((r) => r.url().endsWith('/api/app/updates/check') && r.request().method() === 'POST');
    response.catch(() => {});
    await page.getByRole('button', { name: 'Check for updates', exact: true }).click();
    const result = await (await response).json();
    await until(async () => await page.getByRole('button', { name: 'Check for updates', exact: true }).isEnabled(), 'Update check did not settle');
    return result;
  }
  let updateCheck = await checkFromUI(); assert.equal(updateCheck.app.reason, 'local-changes');
  assert(await page.getByRole('button', { name: 'Update app and skills', exact: true }).isDisabled());
  assert.equal(git(app, 'rev-parse', 'HEAD'), stableHead); preserved();
  mark('local application edits block the update button without touching studio data');
  put(localPackage, priorPackage);
  updateCheck = await checkFromUI(); assert.equal(updateCheck.app.can, true);
  const refused = page.waitForResponse((r) => r.url().endsWith('/api/app/updates/pull') && r.request().method() === 'POST');
  refused.catch(() => {});
  await page.getByRole('button', { name: 'Update app and skills', exact: true }).click();
  const refusal = await (await refused).json(); assert.equal(refusal.updated, false);
  assert.match(refusal.text, /changes runtime requirements/);
  await page.getByText('This release changes runtime requirements.', { exact: false }).waitFor();
  assert.equal(git(app, 'rev-parse', 'HEAD'), stableHead); assert.equal((await api()).bootId, stable.bootId);
  assert.equal(text(skillPath('rough-cut')), forkTwo); preserved();
  mark('runtime requirement changes refuse automatic pull and leave app/skills/boot unchanged');
  git(app, 'remote', 'set-url', 'origin', join(root, 'missing-origin.git'));
  updateCheck = await checkFromUI(); assert.equal(updateCheck.app.offline, true);
  await page.getByText("Couldn't reach origin", { exact: true }).waitFor();
  assert.equal(git(app, 'rev-parse', 'HEAD'), stableHead); preserved();
  git(app, 'remote', 'set-url', 'origin', origin);
  mark('failed local-origin fetch is reported and preserves app/creator files');

  assert.deepEqual(pageErrors, []); assert.deepEqual(blockedRequests, []);
  assert.equal(git(app, 'remote', 'get-url', 'origin'), origin);
  assert.equal((await api()).auto, false);
  assert.deepEqual(json(join(local, 'schedules.json')).schedules, []);
  evidence.finalAppCommit = git(app, 'rev-parse', 'HEAD');
  evidence.preferencesSha256 = createHash('sha256').update(text(preferencePath)).digest('hex');
  mark('no browser errors, remote browser requests, automatic updates or schedules');
  success = true;
} catch (e) {
  evidence.errors.push(e.stack || e.message);
  if (browser) { try { const pages = browser.contexts().flatMap((c) => c.pages()); if (pages[0]) await pages[0].screenshot({ path: join(root, 'failure.png'), fullPage: true }); } catch {} }
  console.error(e.stack || e.message);
} finally {
  if (browser) await browser.close();
  await shutdown();
  evidence.success = success; evidence.root = root; evidence.elapsedMs = Date.now() - began;
  put(join(root, 'server.log'), serverLog); putJSON(join(root, 'result.json'), evidence);
  console.log(`[managed-skills e2e] ${success ? 'PASS' : 'FAIL'} ${checks.length} checks; evidence ${join(root, 'result.json')}`);
  if (!success) process.exitCode = 1;
}
