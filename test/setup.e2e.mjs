// The onboarding screens through the real page, in headless Chromium: the scan (Agents in order with Claude Code
// outlined and recommended, Tools with ffmpeg first, "Check my machine" with one recommended pick per model row and
// every other model folded behind "Show all models", no cache paths), then Continue to "Make it yours", back, and Skip
// into the app. Nothing is connected, installed or downloaded.
//   STUDIO_URL=http://127.0.0.1:4821 PLAYWRIGHT_PATH=… node test/setup.e2e.mjs
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_PATH || 'playwright');
const BASE = (process.env.STUDIO_URL || 'http://127.0.0.1:4821').replace(/\/$/, '');
const fail = (m) => { console.error(`[setup e2e] ${m}`); process.exit(1); };
const must = (c, m) => { if (!c) fail(m); };

const b = await chromium.launch({ headless: true });
try {
  const p = await b.newPage({ viewport: { width: 1440, height: 1600 } });
  const errs = [];
  p.on('pageerror', (e) => errs.push(e.message));
  await p.goto(`${BASE}/#/setup`);
  await p.waitForSelector('#agents .su-item[data-agent]', { timeout: 60000 });
  const order = await p.$$eval('#agents .su-item[data-agent]', (l) => l.map((li) => li.dataset.agent));
  must(order.join() === 'claude,codex,lmstudio,ollama,pi', `agents: ${order}`);
  must(await p.$eval('#agents [data-agent=claude]', (li) => li.classList.contains('su-rec') && /Recommended/.test(li.innerText)), 'Claude Code is not outlined as recommended');
  must((await p.$$eval('#tools .su-item', (l) => l.map((li) => li.dataset.id)))[0] === 'ffmpeg', 'ffmpeg is not first');
  must(!(await p.isVisible('#youView')) && !(await p.isVisible('.ob-steps')), 'the steps sit under the scan');
  // Check my machine: one recommended pick per row, the rest folded.
  await p.click('#machineBtn');
  await p.waitForFunction(() => document.querySelectorAll('#machine .su-item').length && ![...document.querySelectorAll('#machine .su-item')].some((li) => li.classList.contains('checking')), null, { timeout: 120000 });
  const rows = await p.$$eval('#machine .su-item:not([hidden])', (l) => l.map((li) => ({ id: li.dataset.id, rec: li.querySelector('.su-recl')?.innerText || '', open: li.querySelector('details.su-all')?.open, listShown: Boolean(li.querySelector('.su-models')?.checkVisibility()), text: li.innerText })));
  must(rows.length >= 1 && rows.every((r) => /^Recommended for this computer: /.test(r.rec) && r.open === false && !r.listShown), `rows: ${JSON.stringify(rows.map((r) => [r.id, r.rec, r.open, r.listShown]))}`);
  must(rows.every((r) => !/huggingface\/hub|\.cache|\/hub\b/.test(r.text) && !/the best model already downloaded \(now/.test(r.text)), 'a cache path or the long Auto sentence is on the screen');
  await p.click('#machine .su-item[data-id=whisper] details.su-all > summary');
  must(await p.isVisible('#machine .su-item[data-id=whisper] .su-models') && await p.isVisible('#machine .su-item[data-id=whisper] .su-eng'), 'Show all models does not open the list and the build');
  // Continue: the next screen, then back, then Skip into the app.
  await p.click('#scanNext');
  await p.waitForSelector('#youView', { state: 'visible', timeout: 10000 }).catch(() => {});
  must(await p.isVisible('#youView') && !(await p.isVisible('#scanView')) && await p.isVisible('.ob-tab[data-step=about]'), 'Continue does not lead to Make it yours');
  await p.click('#youBack');
  must(await p.isVisible('#scanView') && !(await p.isVisible('#youView')), 'Back does not return to the scan');
  await p.click('#scanNext');
  await p.waitForSelector('#youView', { state: 'visible', timeout: 10000 });
  await p.click('#skip');
  await p.waitForFunction(() => location.hash === '#/' || location.hash === '', null, { timeout: 10000 });
  must(!errs.length, `page errors: ${errs.join(' | ')}`);
  const st = await (await fetch(`${BASE}/api/app/setup`)).json();
  must(st.done === true, 'Continue did not finish the scan');
  console.log(`[setup e2e] all checks passed (${rows.map((r) => `${r.id}: ${r.rec.replace(/\s+/g, ' ')}`).join('; ')})`);
} finally { await b.close(); }
