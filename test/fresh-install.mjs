// Test-only entry point. Never run the app on a developer's computer.
// No model prompts, credentials, artifact uploads, caches or automatic reruns.
import { spawn, execFile } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { homedir, release, arch } from 'node:os';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { checkExports } from './fresh-install-export.mjs';
import { checkProviders } from './fresh-install-providers.mjs';

if (process.env.GITHUB_ACTIONS !== 'true' || !process.env.RUNNER_TEMP) {
  throw new Error('This fresh-install harness runs only in a GitHub Actions disposable runner.');
}
const repo = resolve('.');
const evidenceDir = join(process.env.RUNNER_TEMP, 'octopus-evidence');
mkdirSync(evidenceDir, { recursive: true });
const baseUrl = 'http://127.0.0.1:4800';
const results = [];
const record = (name, status, details) => {
  const row = { name, status, details };
  results.push(row);
  console.log(`EVIDENCE ${JSON.stringify(row)}`);
  writeFileSync(join(evidenceDir, 'results.json'), JSON.stringify(results, null, 2));
};
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
const command = (bin, args, timeout = 15000) => new Promise((done) => {
  execFile(bin, args, { cwd: repo, timeout, maxBuffer: 1024 * 1024 }, (err, out, stderr) =>
    done({ ok: !err, code: err?.code ?? 0, stdout: String(out).trim(), stderr: String(stderr).trim() }));
});
const api = async (route, body) => {
  const r = await fetch(`${baseUrl}${route}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { 'X-Studio': '1', 'Content-Type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(45000),
  });
  const data = await r.json();
  if (!r.ok) throw new Error(`${route}: HTTP ${r.status}: ${JSON.stringify(data)}`);
  return data;
};
const safe = async (name, fn) => {
  try { return await fn(); }
  catch (e) { record(name, 'fail', { error: String(e.message || e) }); return null; }
};
let child, browser;
let serverLog = '';
const childEnv = Object.fromEntries(Object.entries(process.env).filter(([k]) =>
  !/TOKEN|SECRET|PASSWORD|CREDENTIAL|API_KEY|PRIVATE_KEY|^ACTIONS_|^GITHUB_/i.test(k)));
Object.assign(childEnv, {
  STUDIO_NO_OPEN: '1', STUDIO_NO_SCHEDULES: '1', PORT: '4800',
  STUDIO_LOCAL_DIR: join(repo, 'local'), HOMEBREW_NO_AUTO_UPDATE: '1',
});
process.env.STUDIO_LOCAL_DIR = childEnv.STUDIO_LOCAL_DIR;

async function uiEvidence() {
  const require = createRequire(import.meta.url);
  const { chromium } = require(join(process.env.RUNNER_TEMP, 'octopus-browser', 'node_modules', 'playwright'));
  browser = await chromium.launch({
    channel: process.platform === 'win32' ? 'msedge' : 'chrome', headless: true,
  });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(baseUrl, { waitUntil: 'domcontentloaded', timeout: 45000 });
  await page.waitForSelector('#agents .su-item[data-agent]', { timeout: 60000 });
  await page.waitForFunction(() => !document.querySelector('#tools .checking'), null, { timeout: 60000 });
  record('First-launch browser scan', 'pass', {
    url: page.url(),
    agents: await page.locator('#agents').innerText(),
    tools: await page.locator('#tools').innerText(),
    pageErrors: errors,
    browser: process.platform === 'win32' ? 'Edge (runner preinstalled)' : 'Chrome (runner preinstalled)',
  });
  await page.locator('#scanNext').click();
  await page.locator('#youView').waitFor({ state: 'visible' });
  await page.locator('#skip').click();
  await page.waitForFunction(() => location.hash === '#/' || location.hash === '', null, { timeout: 15000 });
  record('Continue without connecting an agent', (await api('/api/app/setup')).done ? 'pass' : 'fail',
    { url: page.url(), pageErrors: errors });
  await page.goto(`${baseUrl}/#/settings/claude`, { waitUntil: 'domcontentloaded' });
  await page.getByRole('radio', { name: 'Codex', exact: true }).waitFor({ timeout: 15000 });
  record('Backend selection screen', 'pass', {
    text: (await page.locator('main').innerText().catch(() => page.locator('body').innerText())).slice(0, 12000),
  });
  await browser.close();
  browser = null;
}

try {
  record('Scope', 'info', {
    commit: process.env.GITHUB_SHA, image: process.env.ImageOS,
    imageVersion: process.env.ImageVersion, os: process.platform, release: release(), arch: arch(),
    node: process.version, nodeMinimum20Tested: false,
    note: 'Fresh hosted account and checkout, not a bare consumer OS. Preinstalled tools are recorded, not removed.',
    prerequisites: 'README requires Node, a separately configured agent, Chrome/Edge; git is also needed for clone.',
    checkout: 'Authenticated checkout of a private repo, not an anonymous clone test.',
    browserDriver: 'Playwright is harness-only and installed outside the app. No app npm installation.',
    inference: 'No real inference, sign-in, paid model call or model download.',
  });
  const tools = await Promise.all([
    ['git', ['--version']], ['ffmpeg', ['-version']], ['ffprobe', ['-version']],
    [process.platform === 'win32' ? 'python' : 'python3', ['--version']],
    [process.platform === 'win32' ? 'winget' : 'brew', ['--version']],
  ].map(async ([bin, args]) => ({ bin, ...(await command(bin, args)) })));
  record('Preinstalled runner dependencies', 'info',
    tools.map((x) => ({ ...x, stdout: x.stdout.slice(0, 1800), stderr: x.stderr.slice(0, 1000) })));
  const expectedStudio = join(homedir(), 'Video Octopus');
  if (existsSync(join(repo, 'local', 'settings.json')) || existsSync(expectedStudio)) {
    throw new Error('Runner is not fresh: app settings or default studio already exist; refusing to overwrite.');
  }
  child = spawn(process.platform === 'win32' ? (process.env.ComSpec || 'cmd.exe') : join(repo, 'start.sh'),
    process.platform === 'win32' ? ['/d', '/s', '/c', 'start.cmd'] : [],
    { cwd: repo, env: childEnv, stdio: ['ignore', 'pipe', 'pipe'], detached: process.platform !== 'win32' });
  child.on('error', (e) => { serverLog += `SPAWN ERROR: ${e.message}\n`; });
  for (const stream of [child.stdout, child.stderr]) stream.on('data', (b) => { serverLog = (serverLog + b).slice(-250000); });
  let ready = false;
  for (let n = 0; n < 60; n++) {
    if (child.exitCode !== null) break;
    try {
      const r = await fetch(`${baseUrl}/api/app/setup`, { signal: AbortSignal.timeout(1500) });
      if (r.ok) { ready = true; break; }
    } catch {}
    await pause(1000);
  }
  record('README launcher', ready ? 'pass' : 'fail', {
    command: process.platform === 'win32' ? 'start.cmd' : './start.sh',
    exitCode: child.exitCode, output: serverLog.slice(-12000),
  });
  if (!ready) throw new Error('README launcher did not serve the application; later checks are blocked.');
  record('First-run studio creation', existsSync(join(expectedStudio, 'CLAUDE.md')) ? 'pass' : 'fail',
    { path: expectedStudio, setup: await api('/api/app/setup') });
  const initial = {};
  await Promise.all(['ffmpeg', 'python', 'folders', 'recorder', 'claude'].map(async (id) => {
    initial[id] = await safe(`Initial ${id} check`, () => api(`/api/app/setup/check?id=${id}`));
    if (initial[id]) record(`Initial ${id} readiness`, 'info', initial[id]);
  }));
  record('Unmodified provider discovery', 'info', await api('/api/app/scan/agents'));
  await safe('Browser onboarding', uiEvidence);
  // Follow only the app's offered dependency action. Never substitute choco,
  // download an unofficial binary, or install models to turn a failure green.
  if (initial.ffmpeg?.state !== 'ok') {
    if (!initial.ffmpeg?.install?.action) {
      record('FFmpeg installation', 'blocked', { reason: 'The app offers no automated installer.', check: initial.ffmpeg });
    } else {
      await safe('FFmpeg installation', async () => {
        let job = await api('/api/app/scan/action', { action: 'ffmpeg', confirmed: true });
        const until = Date.now() + 10 * 60 * 1000;
        while (job.state === 'running' && Date.now() < until) {
          await pause(3000);
          job = await api('/api/app/scan/action?id=ffmpeg');
        }
        record('App-offered FFmpeg install command', job.state === 'done' && job.code === 0 ? 'pass' : 'fail', job);
      });
    }
  }
  const finalFfmpeg = await api('/api/app/setup/check?id=ffmpeg');
  record('FFmpeg readiness after offered install', finalFfmpeg.state === 'ok' ? 'pass' : 'blocked', finalFfmpeg);
  await safe('Provider metadata fixtures', () => checkProviders({ repo, baseUrl, evidenceDir, record }));
  if (finalFfmpeg.state === 'ok') {
    await safe('Synthetic media and exports', async () => {
      // Use the same discovery paths as the app, including a newly created
      // WinGet Links directory; do not substitute a private test-only binary.
      const { studioTool, childPathEnv } = await import(pathToFileURL(join(repo, 'server', 'util.mjs')).href);
      process.env.PATH = (await childPathEnv()).PATH;
      return checkExports({ repo, baseUrl, evidenceDir, record,
        ffmpeg: studioTool('ffmpeg'), ffprobe: studioTool('ffprobe') });
    });
  } else {
    record('Synthetic media and exports', 'blocked', { reason: 'App cannot discover FFmpeg/ffprobe. No substitute installation attempted.' });
  }
} catch (e) {
  record('Harness completion', 'fail', { error: String(e.stack || e) });
} finally {
  await browser?.close().catch(() => {});
  if (child?.pid) {
    if (process.platform === 'win32') await command('taskkill', ['/PID', String(child.pid), '/T', '/F']);
    else { try { process.kill(-child.pid, 'SIGTERM'); } catch {} }
  }
  writeFileSync(join(evidenceDir, 'server.log'), serverLog);
  console.log(`SERVER_LOG_TAIL\n${serverLog.slice(-18000)}\nEND_SERVER_LOG`);
  const clean = (s) => String(s).replace(/[|\n\r]/g, ' ').replace(/</g, '&lt;');
  const summary = [
    `# Fresh install: ${process.platform} ${arch()}`,
    `Commit: ${process.env.GITHUB_SHA}`,
    'Fresh hosted runner with preinstalled development tools. No real model inference. No artifacts or caches retained.',
    '',
    '| Check | Result | Evidence |', '| --- | --- | --- |',
    ...results.map((r) => `| ${clean(r.name)} | ${r.status} | ${clean(JSON.stringify(r.details)).slice(0, 5000)} |`),
    '', 'Full structured evidence is in this job’s EVIDENCE log lines.',
  ].join('\n');
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, summary + '\n');
  process.exitCode = results.some((r) => r.status === 'fail' || r.status === 'blocked') ? 1 : 0;
}
