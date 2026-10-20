// Disposable, local-only browser regression for generated scene/background isolation.
// Run: PLAYWRIGHT_PATH=/path/to/playwright node test/security-boundaries.e2e.mjs
// Optional: CHROMIUM_PATH=/path/to/chrome, SECURITY_REPORT=/path/to/result.json.
// A failing isolation check exits 1. No real studio, keys, agent or external API is used.
// Test instrumentation: the copied scenes.js gets an export of its existing SceneFrames
// constructor. A blank page invokes that constructor and the unchanged painterFor.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { execFileSync, spawn } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync, chmodSync } from 'node:fs';
import { dirname, join, resolve, relative } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:net';
import { createHash, randomUUID } from 'node:crypto';

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_PATH || 'playwright');
const source = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const root = mkdtempSync(join(realpathSync(tmpdir()), 'octopus-security-'));
const app = join(root, 'app'), studio = join(root, 'studio'), local = join(root, 'local');
const home = join(root, 'home'), bin = join(root, 'bin'), temp = join(root, 'tmp');
const write = (path, text) => { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, text); };
const json = (path, data) => write(path, JSON.stringify(data, null, 2) + '\n');
const read = (path) => JSON.parse(readFileSync(path, 'utf8'));
const delay = (ms) => new Promise((done) => setTimeout(done, ms));
const report = { at: new Date().toISOString(), node: process.version, platform: process.platform,
  instrumentation: 'Copied scenes.js plus export { SceneFrames }; blank host invokes actual constructor and painterFor; actual server routes, no API mocks.',
  checks: [], requests: [], responses: [], failedRequests: [], browserErrors: [], browserConsole: [], blockedBrowserRequests: [], sourceHash: null };
let server, browser, page, port, base, serverLog = '', serverClosed = false;
const marker = `synthetic-sentinel-${randomUUID()}`;

try {
  port = await new Promise((done, fail) => {
    const s = createServer(); s.once('error', fail); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => done(p)); });
  });
  base = `http://127.0.0.1:${port}`;
  // Copy current tracked/new generic implementation sources, never .git or local data.
  const files = execFileSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard', '--',
    'server', 'web', 'core', 'starter', 'bin', 'package.json'], { cwd: source, encoding: 'utf8' }).split('\0').filter(Boolean);
  assert.ok(files.includes('server/index.mjs') && files.includes('web/scenes.js'));
  const hash = createHash('sha256');
  for (const file of [...new Set(files)].sort()) {
    if (!existsSync(join(source, file))) continue;
    assert.ok(!file.split('/').some((part) => ['.git', 'local'].includes(part)));
    const bytes = readFileSync(join(source, file));
    hash.update(file).update('\0').update(bytes);
    write(join(app, file), bytes);
  }
  report.sourceHash = hash.digest('hex');
  report.sourceFiles = files.length;
  for (const path of [home, bin, temp, local, join(studio, 'projects', 'probe', 'assets'), join(studio, 'projects', 'other')]) mkdirSync(path, { recursive: true });
  json(join(studio, 'projects', 'probe', 'project.json'), { name: 'Synthetic isolation probe', type: 'tutorial' });
  json(join(studio, 'projects', 'other', 'project.json'), { name: 'Other synthetic project', type: 'tutorial' });
  json(join(studio, 'projects', 'other', 'sentinel.json'), { sentinel: marker });
  // An explicit fake executable prevents all agent discovery from reaching an installed CLI.
  const stub = join(bin, 'fake-tool');
  write(stub, '#!/bin/sh\ncase "$1" in\n--version) echo "0.0.0 synthetic";;\nauth) echo \'{"loggedIn":false}\';;\n*) exit 1;;\nesac\n');
  chmodSync(stub, 0o700);
  const shell = join(bin, 'fake-shell');
  write(shell, '#!/bin/sh\nprintf "__P__%s__P__" "$PATH"\n'); chmodSync(shell, 0o700);
  copyFileSync(stub, join(bin, 'git')); chmodSync(join(bin, 'git'), 0o700);
  json(join(local, 'settings.json'), { studio, projectsDir: 'projects', recordingsDir: join(studio, 'recordings'),
    setup: { done: true }, updates: { auto: false }, model: 'before-probe', permissionMode: 'manual',
    claudePath: stub, codexPath: stub, piPath: stub, ffmpeg: stub, ffprobe: stub, python: stub });

  // Guard the disposable server: fail closed on outbound requests or any executable outside stubs.
  const guard = join(root, 'guard.mjs');
  write(guard, `import cp from 'node:child_process';
import net from 'node:net';
import { syncBuiltinESMExports } from 'node:module';
import { appendFileSync } from 'node:fs';
const bin = ${JSON.stringify(bin)}, log = ${JSON.stringify(join(root, 'guard.jsonl'))};
for (const method of ['spawn','spawnSync','execFile','execFileSync','exec','execSync']) {
  const original = cp[method]; cp[method] = function(command, ...args) {
    appendFileSync(log, JSON.stringify({ type: 'child', command: String(command), allowed: String(command).startsWith(bin + '/') || command === 'git' }) + '\\n');
    if (!String(command).startsWith(bin + '/') && command !== 'git') throw new Error('Isolation fixture blocked child executable');
    return original.call(this, command, ...args);
  };
}
const originalConnect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function(...args) {
  const options = Array.isArray(args[0]) ? args[0][0] : args[0];
  const host = typeof options === 'object' ? options.host : (typeof args[1] === 'string' ? args[1] : '127.0.0.1');
  const port = typeof options === 'object' ? Number(options.port) : Number(options);
  if (!['127.0.0.1','localhost','::1'].includes(host || '127.0.0.1') || port !== ${port}) {
    appendFileSync(log, JSON.stringify({ type: 'network-blocked', host, port }) + '\\n');
    throw new Error('Isolation fixture blocked outbound connection');
  }
  return originalConnect.apply(this, args);
};
syncBuiltinESMExports();
`);
  const childEnv = { HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: join(home, '.config'), XDG_CACHE_HOME: join(home, '.cache'),
    CODEX_HOME: join(home, '.codex'), CLAUDE_CONFIG_DIR: join(home, '.claude'), PI_CODING_AGENT_DIR: join(home, '.pi'),
    APPDATA: join(home, 'AppData', 'Roaming'), LOCALAPPDATA: join(home, 'AppData', 'Local'),
    PATH: [bin, dirname(process.execPath), '/usr/bin', '/bin'].join(':'), SHELL: shell, ZDOTDIR: home,
    TMPDIR: temp, TMP: temp, TEMP: temp, LANG: 'en_US.UTF-8', PORT: String(port), STUDIO_LOCAL_DIR: local,
    STUDIO_NO_SCHEDULES: '1', STUDIO_KEYCHAIN_SERVICE: `Video Octopus synthetic ${randomUUID()}` };
  server = spawn(process.execPath, ['--import', guard, join(app, 'server', 'index.mjs')], { cwd: app, env: childEnv, stdio: ['ignore', 'pipe', 'pipe'] });
  server.stdout.on('data', (d) => { serverLog += d; }); server.stderr.on('data', (d) => { serverLog += d; });
  server.on('exit', () => { serverClosed = true; });
  const until = async (name, fn, ms = 20000) => {
    const start = Date.now();
    while (Date.now() - start < ms) { const result = await fn().catch(() => null); if (result) return result; if (serverClosed) throw new Error(`Server exited before ${name}: ${serverLog}`); await delay(50); }
    throw new Error(`Timed out: ${name}`);
  };
  await until('server listening', async () => (await fetch(`${base}/ui.js`)).ok);
  report.serverPid = server.pid; report.port = port;

  // The same harmless probe runs as project scene script and project code-background module.
  const probe = (kind) => `const result = { kind: ${JSON.stringify(kind)} };
try { result.parentMarker = parent.document.documentElement.dataset.fixtureSentinel; } catch (e) { result.parentError = e.name; }
try { const r = await fetch(${JSON.stringify(base + '/api/projects/other/files/sentinel.json')}); result.readStatus = r.status; result.readSentinel = (await r.json()).sentinel; } catch (e) { result.readError = e.name; }
try { const r = await fetch(${JSON.stringify(base + '/api/settings')}, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Studio': '1' }, body: JSON.stringify({ model: ${JSON.stringify(`${kind}-sentinel`)} }) }); result.writeStatus = r.status; } catch (e) { result.writeError = e.name; }
globalThis.__securityProbe = result;
parent.postMessage({ type: 'synthetic-security-probe', result }, '*');`;
  const kit = execFileSync('git', ['show', 'HEAD:core/kit/octopus-scene.js'], { cwd: source });
  write(join(studio, 'projects', 'probe', 'assets', 'octopus-scene.js'), kit);
  json(join(studio, 'projects', 'probe', 'work', 'production.json'), { scenes: [{ id: 'fixture', start: 0, end: 10 }] });
  json(join(studio, 'projects', 'probe', 'work', 'overrides.json'), { v: 1, scenes: {} });
  write(join(studio, 'projects', 'probe', 'assets', 'tile.svg'), '<svg xmlns="http://www.w3.org/2000/svg" width="8" height="8"><rect width="8" height="8" fill="#ff0000"/></svg>');
  write(join(studio, 'projects', 'probe', 'scene.html'), `<!doctype html><title>Synthetic scene</title>
<script src="assets/octopus-scene.js"></script><div data-studio="title" style="position:absolute;left:10px;top:10px;width:80px;height:20px">Fixture</div>
<img id="tile" src="assets/tile.svg" width="8" height="8">
<script>window.ready = document.querySelector('#tile').decode(); window.seek = (t) => { document.querySelector('[data-studio]').style.left = (10 + t * 10) + 'px'; };</script>
<script type="module">${probe('scene')}</script>`);
  write(join(studio, 'projects', 'probe', 'assets', 'probe.js'), `${probe('background')}\nexport default { name: 'Synthetic background', draw(g, W, H, t) { g.fillStyle = t < 1 ? '#ff0000' : '#00ff00'; g.fillRect(0, 0, W, H); } };\n`);
  write(join(studio, 'projects', 'probe', 'direct.html'), `<!doctype html><script type="module">${probe('direct-html')}</script>`);
  write(join(studio, 'projects', 'probe', 'direct.svg'), `<svg xmlns="http://www.w3.org/2000/svg"><script><![CDATA[(async () => { ${probe('direct-svg')} })();]]></script></svg>`);
  write(join(studio, 'projects', 'probe', 'navigation.html'), `<!doctype html><script>location.href = ${JSON.stringify(base + '/security-test-host.html?escape=scene')};</script>`);
  write(join(app, 'web', 'security-scenes-test.js'), readFileSync(join(app, 'web', 'scenes.js'), 'utf8') + '\nexport { SceneFrames };\n');
  write(join(app, 'web', 'security-test-host.html'), '<!doctype html><html><title>Synthetic security host</title><body><div id="host" style="width:640px;height:360px"></div></body></html>');
  const executablePath = process.env.CHROMIUM_PATH || chromium.executablePath();
  assert.ok(existsSync(executablePath), `Cached browser unavailable: ${executablePath}`);
  browser = await chromium.launch({ headless: true, executablePath, env: childEnv,
    args: ['--disable-background-networking', '--disable-component-update', '--disable-domain-reliability', '--disable-sync', '--no-first-run'] });
  // A fresh profile has no service workers. Production CSP/response guards block
  // generated workers; Playwright's service-worker shim cannot run in opaque frames.
  const context = await browser.newContext();
  context.on('response', (r) => report.responses.push({ path: new URL(r.url()).pathname, status: r.status() }));
  context.on('requestfailed', (r) => report.failedRequests.push({ path: new URL(r.url()).pathname, error: r.failure()?.errorText }));
  const allowedOrigins = new Set([base]);
  const allowSandbox = (value) => {
    const sandbox = new URL(value);
    assert.equal(sandbox.protocol, 'http:'); assert.equal(sandbox.hostname, '127.0.0.1');
    assert.notEqual(sandbox.origin, base); allowedOrigins.add(sandbox.origin);
  };
  await context.route('**/*', async (route) => {
    const request = route.request(), url = new URL(request.url());
    if (!allowedOrigins.has(url.origin)) { report.blockedBrowserRequests.push(url.origin); return route.abort(); }
    report.requests.push({ method: request.method(), path: url.pathname });
    // Preserve the actual response; register only sandbox origins minted by this
    // disposable app before the browser follows its capability URL/redirect.
    // Never fulfill the trusted host document: doing so replaces its real
    // loopback address-space metadata and makes Chrome's LNA checks reject frames.
    if (url.origin === base && (url.pathname === '/api/sandbox' || (request.isNavigationRequest() && url.pathname.startsWith('/api/projects/')))) {
      const response = await route.fetch({ maxRedirects: 0 });
      if (url.pathname === '/api/sandbox' && response.ok()) allowSandbox((await response.json()).url);
      const location = response.headers().location;
      if (location && new URL(location, base).origin !== base) allowSandbox(new URL(location, base).href);
      return route.fulfill({ response });
    }
    return route.continue();
  });
  page = await context.newPage();
  page.on('pageerror', (error) => report.browserErrors.push(error.message));
  page.on('console', (m) => { if (['error', 'warning'].includes(m.type())) report.browserConsole.push(m.text().slice(0, 500)); });
  await page.goto(`${base}/security-test-host.html`);
  await page.evaluate((marker) => {
    document.documentElement.dataset.fixtureSentinel = marker;
    window.securityResults = [];
    addEventListener('message', (event) => { if (event.data?.type === 'synthetic-security-probe') window.securityResults.push(event.data.result); });
  }, marker);
  // Negative control: the actual server refuses a write missing its required app header.
  const refused = await page.evaluate(async () => (await fetch('/api/settings', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ model: 'must-not-save' }) })).status);
  assert.equal(refused, 403); assert.equal(read(join(local, 'settings.json')).model, 'before-probe');
  report.checks.push({ check: 'missing app header rejected', passed: true, status: refused });

  await page.evaluate(async () => {
    const { SceneFrames } = await import('/security-scenes-test.js');
    window.framesUnderTest = new SceneFrames(document.querySelector('#host'), { src: '/api/projects/probe/files/scene.html?studio=edit', layers: [], frame: [640, 360] });
  });
  await page.waitForFunction(() => window.securityResults.some((r) => r.kind === 'scene'), null, { timeout: 10000 });
  const scene = await page.evaluate(() => ({ ...window.securityResults.find((r) => r.kind === 'scene'), sandbox: document.querySelector('iframe.sf')?.getAttribute('sandbox') }));
  scene.persistedModel = read(join(local, 'settings.json')).model;
  scene.exposed = scene.readSentinel === marker || scene.persistedModel === 'scene-sentinel' || scene.parentMarker === marker;
  report.checks.push({ check: 'generated scene isolated from app privileges', passed: !scene.exposed, evidence: scene });

  const drawn = await page.evaluate(async () => {
    const pending = window.framesUnderTest.draw(2, { v: 1, scenes: { '*': { title: { dx: 5, dy: 0, scale: 1 } } } });
    for (let i = 0; i < 20 && !window.framesUnderTest.waiting.size; i++) await Promise.resolve();
    const req = [...window.framesUnderTest.waiting.keys()][0];
    if (!req) throw new Error('Frame request was not issued');
    // An unrelated sender must not be able to complete the pending frame request.
    window.dispatchEvent(new MessageEvent('message', { origin: 'null', source: window, data: { type: 'studio:drawn', req, hits: [{ id: 'forged' }] } }));
    return await pending;
  });
  assert.ok(drawn.length > 0 && drawn.every((frame) => !frame.error));
  const title = drawn.flatMap((frame) => frame.hits || []).find((hit) => hit.id === 'title');
  assert.ok(title && Math.abs(title.x - 35) < 1, 'Legacy scene kit, local image, seek and overrides must still work');
  assert.ok(!drawn.some((frame) => frame.hits?.some((hit) => hit.id === 'forged')), 'Unrelated sender forged a frame reply');
  report.checks.push({ check: 'legacy scene drawing and overrides work; unrelated replies rejected', passed: true });

  await page.evaluate(async () => {
    const { painterFor } = await import('/look.js');
    const painter = await painterFor({ kind: 'code', file: 'assets/probe.js' }, { url: (file) => `/api/projects/probe/files/${file}` });
    window.backgroundUnderTest = painter;
    const canvas = document.createElement('canvas'); canvas.width = canvas.height = 16;
    window.backgroundCanvas = canvas;
    await painter.prepare?.(0, 16, 16);
    painter.paint(canvas.getContext('2d'), 16, 16, 0);
  });
  await page.waitForFunction(() => window.securityResults.some((r) => r.kind === 'background'), null, { timeout: 10000 });
  const background = await page.evaluate(() => window.securityResults.find((r) => r.kind === 'background'));
  background.persistedModel = read(join(local, 'settings.json')).model;
  background.exposed = background.readSentinel === marker || background.persistedModel === 'background-sentinel' || background.parentMarker === marker;
  report.checks.push({ check: 'generated background isolated from app privileges', passed: !background.exposed, evidence: background });
  const colors = await page.evaluate(async () => {
    const painter = window.backgroundUnderTest, g = window.backgroundCanvas.getContext('2d');
    const first = [...g.getImageData(8, 8, 1, 1).data];
    await painter.prepare?.(2, 16, 16);
    painter.paint(g, 16, 16, 2);
    return [first, [...g.getImageData(8, 8, 1, 1).data]];
  });
  assert.deepEqual(colors, [[255, 0, 0, 255], [0, 255, 0, 255]], 'Isolated backgrounds must paint exact requested frames');
  report.checks.push({ check: 'custom background draws exact timed pixels without canvas taint', passed: true });

  for (const [kind, file] of [['direct-html', 'direct.html'], ['direct-svg', 'direct.svg']]) {
    await page.evaluate((file) => { const f = document.createElement('iframe'); f.src = `/api/projects/probe/files/${file}`; document.body.append(f); }, file);
    // Direct navigation may use a trusted wrapper with a nested opaque frame.
    // Inspect the fixture's recorded result, never grant it a new parent bridge.
    const evidence = await until(`${kind} probe`, async () => {
      for (const frame of page.frames()) {
        const result = await frame.evaluate(() => globalThis.__securityProbe).catch(() => null);
        if (result?.kind === kind) return result;
      }
      return null;
    }, 10000);
    evidence.persistedModel = read(join(local, 'settings.json')).model;
    assert.notEqual(evidence.readSentinel, marker); assert.notEqual(evidence.parentMarker, marker);
    assert.equal(evidence.persistedModel, 'before-probe');
    report.checks.push({ check: `${kind} file URL is isolated without an iframe sandbox attribute`, passed: true, evidence });
  }
  const importRejected = await page.evaluate(async () => { try { await import('/api/projects/probe/files/assets/probe.js?direct-import'); return false; } catch { return true; } });
  assert.equal(importRejected, true, 'Project JavaScript must not execute as an app-origin module');
  assert.equal(read(join(local, 'settings.json')).model, 'before-probe');
  report.checks.push({ check: 'project JavaScript cannot be imported into the app origin', passed: true });

  for (const file of ['direct.html', 'direct.svg']) {
    const directPage = await context.newPage();
    await directPage.goto(`${base}/api/projects/probe/files/${file}`);
    const evidence = await until(`top-level ${file}`, async () => {
      for (const frame of directPage.frames()) {
        const result = await frame.evaluate(() => globalThis.__securityProbe).catch(() => null);
        if (result) return result;
      }
      return null;
    }, 10000);
    assert.equal(evidence.parentError, 'SecurityError');
    assert.notEqual(evidence.readSentinel, marker); assert.equal(read(join(local, 'settings.json')).model, 'before-probe');
    assert.equal(await directPage.locator('iframe[sandbox="allow-scripts"]').count(), 1);
    report.checks.push({ check: `top-level ${file} opens inside an inert isolated wrapper`, passed: true });
    await directPage.close();
  }
  await page.evaluate(async () => {
    const { SceneFrames } = await import('/security-scenes-test.js');
    window.navigationUnderTest = new SceneFrames(document.querySelector('#host'), { src: '/api/projects/probe/files/navigation.html', layers: [], frame: [16, 16] });
    await Promise.all(window.navigationUnderTest.frames.map((f) => f.ready));
  });
  await delay(150); // Let the attempted document navigation finish or be rejected.
  // Inspect from the untrusted frame's realm, not by reading its parent via the host.
  const navElement = await page.locator('#host iframe.sf').last().elementHandle();
  const navFrame = await navElement.contentFrame();
  assert.ok(navFrame && navFrame !== page.mainFrame(), 'The attempted navigation must retain an isolated child frame');
  assert.equal(await navFrame.evaluate(() => { try { return parent.document.documentElement.dataset.fixtureSentinel || null; } catch { return null; } }), null);
  assert.equal(read(join(local, 'settings.json')).model, 'before-probe');
  report.checks.push({ check: 'scene self-navigation cannot gain parent privileges', passed: true });
  await page.evaluate(() => window.navigationUnderTest.destroy());
  await page.evaluate(() => { window.framesUnderTest.destroy(); window.backgroundUnderTest.dispose?.(); });
  // Evidence is synthetic only. Remove the random value to keep output small and reusable.
  for (const check of report.checks) if (check.evidence) {
    check.evidence.readSentinelMatched = check.evidence.readSentinel === marker;
    check.evidence.parentMarkerMatched = check.evidence.parentMarker === marker;
    delete check.evidence.readSentinel; delete check.evidence.parentMarker;
  }
  report.failed = report.checks.filter((check) => !check.passed).length;
  process.exitCode = report.failed ? 1 : 0;
} catch (error) {
  if (page) report.framesAtFailure = await Promise.all(page.frames().map((f) => f.evaluate(() => ({ url: location.href, markup: document.documentElement.outerHTML.slice(0, 500) })).catch((e) => ({ error: e.message }))));
  report.error = error.stack || String(error); process.exitCode = 2;
} finally {
  await browser?.close().catch(() => {});
  if (server && !serverClosed) {
    server.kill('SIGTERM');
    for (let i = 0; i < 40 && !serverClosed; i++) await delay(50);
    if (!serverClosed) { server.kill('SIGKILL'); for (let i = 0; i < 40 && !serverClosed; i++) await delay(50); }
  }
  report.serverStopped = server ? serverClosed : true;
  report.guard = existsSync(join(root, 'guard.jsonl')) ? readFileSync(join(root, 'guard.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse).map((r) => ({ ...r, command: r.command ? relative(root, r.command) : undefined })) : [];
  report.serverLog = serverLog.replaceAll(root, '<fixture>');
  rmSync(root, { recursive: true, force: true });
  report.fixtureRemoved = !existsSync(root);
  if (process.env.SECURITY_REPORT) json(resolve(process.env.SECURITY_REPORT), report);
  console.log(JSON.stringify(report, null, 2));
}
