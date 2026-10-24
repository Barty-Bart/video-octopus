// End-to-end check of the recording controls and the script's buttons, through the real UI, in headless Chromium
// with fake devices (Chromium's fake camera and mic; nothing real is opened). Run it against a disposable Video
// Octopus, never the creator's studio:
//
//   STUDIO_URL=http://127.0.0.1:43917 STUDIO_ROOT=<the disposable studio folder> PLAYWRIGHT_PATH=<playwright> \
//     SHOTS=<folder for screenshots> node test/recorder-controls.e2e.mjs
//
// Cases: record → pause → resume → stop (the take leaves the pause out); Delete take → Undo; record → Restart →
// stop (one take, the dropped one in the trash, the script back at the top); the practice script's buttons; the
// script during a take; the script's own window; light and dark; 1440 and 375 px wide. Exits 0 when all pass.
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_PATH || 'playwright');
const BASE = (process.env.STUDIO_URL || 'http://127.0.0.1:43917').replace(/\/$/, '');
const ROOT = process.env.STUDIO_ROOT || '';
const SHOTS = process.env.SHOTS || '';
const FFPROBE = process.env.FFPROBE || 'ffprobe';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log('[controls e2e]', ...a);
const failures = [];
const check = (ok, text) => { if (ok) log(`ok   ${text}`); else { failures.push(text); console.error('[controls e2e] FAIL', text); } };

async function api(path, data) {
  const r = await fetch(BASE + path, data === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Studio': '1' }, body: JSON.stringify(data) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`${path}: ${j.error || r.status}`);
  return j;
}
const shot = async (page, name) => { if (SHOTS) { mkdirSync(SHOTS, { recursive: true }); await page.screenshot({ path: join(SHOTS, `${name}.png`) }); log(`screenshot ${name}.png`); } };
const duration = (f) => Number(execFileSync(FFPROBE, ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', f]).toString().trim());

const SCRIPT = Array.from({ length: 40 }, (_, i) => `Line ${i + 1} of the script. [pause] Keep reading at a steady pace.`).join('\n');

async function newPage(browser, { width = 1440, height = 900, theme = 'light' } = {}) {
  const ctx = await browser.newContext({ permissions: ['camera', 'microphone'], viewport: { width, height }, colorScheme: theme });
  await ctx.addInitScript((t) => { try { localStorage.setItem('studio.theme', JSON.stringify({ theme: t, accent: 'orange', sidebar: 'labels' })); } catch {} }, theme);
  const page = await ctx.newPage();
  page.on('pageerror', (e) => { failures.push(`page error: ${e.message}`); console.error('[page error]', e.message); });
  page.on('console', (m) => { if (m.type() === 'error' && !/favicon|404/.test(m.text())) console.error('[page console]', m.text()); });
  return { ctx, page };
}
async function openProject(browser, id, opts) {
  const { ctx, page } = await newPage(browser, opts);
  await page.goto(`${BASE}/?fakeScreen=1#/p/${encodeURIComponent(id)}`);
  await page.waitForSelector('#recBtn:not([disabled])');
  await page.waitForFunction(() => document.querySelector('#recText')?.textContent === 'Record');
  return { ctx, page };
}
// The record panel set to camera + mic, no countdown.
async function panel(page) {
  await page.click('#recBtn');
  await page.waitForSelector('.rec-page #rStart');
  await page.waitForFunction(() => document.querySelector('#rCamera')?.options.length > 1 && document.querySelector('#rMic')?.options.length > 1, null, { timeout: 20000 });
  if (await page.isVisible('#scrNone')) await page.click('#scrNone');
  await page.selectOption('#rCamera', { index: 1 });
  await page.selectOption('#rMic', { index: 1 });
  await page.waitForFunction(() => document.querySelector('#pvCam')?.srcObject && !document.querySelector('#rStart').disabled);
  await page.click('#rCount [data-c="0"]');
  if (await page.$('#rTarget')) await page.click('#rTarget [data-t="replace"]');
}
const phase = (page) => page.evaluate(() => window.__studioRec.session().phase);
const until = (page, fn, arg, ms = 20000) => page.waitForFunction(fn, arg, { timeout: ms });
const project = (id) => api(`/api/projects/${encodeURIComponent(id)}`);
const scriptY = (page) => page.evaluate(() => document.querySelector('.pp-over .pp-text')?.style.transform || '');

async function main() {
  const id = (await api('/api/projects', { name: 'Recorder controls check', type: 'tutorial' })).id;
  await api(`/api/projects/${encodeURIComponent(id)}/script`, { text: SCRIPT });
  log(`project ${id}`);
  const browser = await chromium.launch({ args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', '--autoplay-policy=no-user-gesture-required'] });
  try {
    // ---- the practice script: buttons, and the keys still work ----
    {
      const { ctx, page } = await openProject(browser, id);
      await panel(page);
      await page.click('.rec-page #scTry');
      await page.waitForSelector('.pp-over.try .ppc');
      const val = (k) => page.textContent(`.pp-over.try [data-v=${k}]`).then(Number);
      const s0 = await val('speed'), z0 = await val('size');
      await page.click('.pp-over.try [data-p=faster]');
      check((await val('speed')) === s0 + 5, `practice: Faster button (${s0} → ${await val('speed')})`);
      await page.click('.pp-over.try [data-p=bigger]');
      check((await val('size')) === z0 + 4, `practice: Bigger button (${z0} → ${await val('size')})`);
      await page.keyboard.press('ArrowDown');
      check((await val('speed')) === s0, 'practice: ↓ still slows it, and the button shows it');
      await page.keyboard.press('Minus');
      check((await val('size')) === z0, 'practice: − still shrinks it');
      const y0 = await page.evaluate(() => document.querySelector('.pp-over.try .pp-text').style.transform);
      await page.click('.pp-over.try [data-p=toggle]');
      check(/Pause/.test(await page.textContent('.pp-over.try .ppc-play')), 'practice: Play button plays (it now says Pause)');
      await sleep(900);
      const y1 = await page.evaluate(() => document.querySelector('.pp-over.try .pp-text').style.transform);
      check(y0 !== y1, 'practice: the script scrolls');
      await shot(page, '01-practice-1440-light');
      await page.click('.pp-over.try [data-p=toggle]');
      check(/Play/.test(await page.textContent('.pp-over.try .ppc-play')), 'practice: Pause button pauses');
      await page.click('.pp-over.try [data-p=forward]');
      await page.click('.pp-over.try [data-p=toStart]');
      check(/translateY\((\d+(\.\d+)?)px\)/.test(await page.evaluate(() => document.querySelector('.pp-over.try .pp-text').style.transform)), 'practice: Start button goes back to the top');
      await page.click('.pp-over.try [data-p=mirror]');
      check(await page.evaluate(() => document.querySelector('.pp-over.try .pp-stage').classList.contains('flipH')), 'practice: Mirror button mirrors');
      await page.click('.pp-over.try [data-p=mirror]');
      await page.keyboard.press('Space');
      check(/Pause/.test(await page.textContent('.pp-over.try .ppc-play')), 'practice: Space still plays');
      await page.keyboard.press('Space');
      const big = await page.$$eval('.pp-over.try .ppc-b', (bs) => bs.every((b) => b.getBoundingClientRect().height >= 40 && b.getBoundingClientRect().width >= 40));
      check(big, 'practice: every button is at least 40 × 40 px');
      await page.click('.pp-over.try [data-a=done]');
      await page.click('#rBack');
      await ctx.close();
    }

    // ---- record → pause → resume → stop; then Delete take → Undo ----
    let firstTake = null;
    {
      const { ctx, page } = await openProject(browser, id);
      await panel(page);
      await page.click('#rStart');
      await until(page, () => window.__studioRec.session().phase === 'recording');
      await page.waitForSelector('.pp-over .rc.docked');
      check(true, 'recording: the controls sit in the script bar');
      await sleep(2000);
      await shot(page, '02-recording-script-docked-1440');
      await page.click('.rc [data-a=pause]');
      await until(page, () => window.__studioRec.session().paused === true);
      const t1 = await page.textContent('.rc .rc-time'), sy1 = await scriptY(page);
      await sleep(2500);
      const t2 = await page.textContent('.rc .rc-time'), sy2 = await scriptY(page);
      check(t1 === t2, `pause: the time stands still (${t1} → ${t2})`);
      check(sy1 === sy2, 'pause: the script pauses with the recording');
      check(/Paused 0:0[12]/.test(await page.textContent('#recText')), `pause: the Record button says Paused and its time stands still (${await page.textContent('#recText')})`);
      check((await page.getAttribute('.rc', 'data-mode')) === 'paused', 'pause: the bar says Paused');
      await shot(page, '03-paused-1440');
      await page.keyboard.press(process.platform === 'darwin' ? 'Meta+Alt+KeyP' : 'Control+Alt+KeyP');
      await until(page, () => window.__studioRec.session().paused === false);
      check(true, 'resume: the pause key resumes');
      await sleep(1200);
      check((await scriptY(page)) !== sy2, 'resume: the script scrolls again');
      await sleep(800);
      await page.click('.rc [data-a=stop]');
      await page.waitForSelector('.rc[data-mode=after]', { timeout: 120000 });
      check(/Take saved/.test(await page.textContent('.rc .rc-msg')), 'stop: the take is saved and Delete take is offered');
      await shot(page, '04-after-take-1440-light');
      const P = await project(id);
      firstTake = P.roles?.take?.[0]?.replace(/_webcam\..+$/, '') || null;
      check(Boolean(firstTake), `stop: the take is the project's take (${P.roles?.take?.join(', ')})`);
      if (P.path && P.roles?.take?.[0]) {
        const d = duration(join(P.path, 'source', P.roles.take[0]));
        check(d > 3 && d < 5.3, `stop: the take is ${d.toFixed(2)} s, without the 2.5 s pause (recorded about 4 s)`);
      }
      // Delete take → Undo
      await page.click('.rc [data-a=delete]');
      await until(page, () => /trash/.test(document.querySelector('.rc .rc-msg')?.textContent || ''));
      let Q = await project(id);
      check(!(Q.roles?.take || []).length, `delete: the project has no take now (${(Q.roles?.take || []).join(', ') || 'none'})`);
      if (ROOT) check(readdirSync(join(ROOT, '.trash')).some((n) => n.endsWith(firstTake)), 'delete: the take is in the studio trash');
      if (ROOT) check(!existsSync(join(ROOT, 'recordings', firstTake)), 'delete: and out of the recordings folder');
      await shot(page, '05-deleted-undo-1440');
      await page.click('.rc [data-a=undo]');
      await until(page, () => /back/.test(document.querySelector('.rc .rc-msg')?.textContent || ''));
      Q = await project(id);
      check((Q.roles?.take || []).some((f) => f.startsWith(firstTake)), 'undo: the take is back in the project');
      if (ROOT) check(existsSync(join(ROOT, 'recordings', firstTake)), 'undo: and in the recordings folder');
      await ctx.close();
    }

    // ---- record → restart → stop: one take; the dropped one in the trash ----
    {
      const { ctx, page } = await openProject(browser, id);
      const before = ROOT ? readdirSync(join(ROOT, 'recordings')).filter((n) => !n.startsWith('.')) : [];
      await panel(page);
      await page.click('#rStart');
      await until(page, () => window.__studioRec.session().phase === 'recording');
      const dropped = await page.evaluate(() => window.__studioRec.session().take);
      await sleep(2200);
      const scrolled = await scriptY(page);
      await page.click('.rc [data-a=restart]');
      check((await page.getAttribute('.rc', 'data-mode')) === 'confirm', 'restart: it asks first ("Restart? This take will be discarded.")');
      await shot(page, '06-restart-confirm-1440');
      await page.click('.rc [data-a=no]');
      check((await page.getAttribute('.rc', 'data-mode')) === 'recording' && (await phase(page)) === 'recording', 'restart: Keep recording keeps it going');
      await page.keyboard.press(process.platform === 'darwin' ? 'Meta+Alt+Shift+KeyR' : 'Control+Alt+Shift+KeyR');
      check((await page.getAttribute('.rc', 'data-mode')) === 'confirm', 'restart: the restart key asks too');
      await page.click('.rc [data-a=yes]');
      await page.waitForSelector('.countdown');
      await shot(page, '07-restart-countdown-1440');
      await until(page, () => window.__studioRec.session().phase === 'recording', null, 15000);
      const fresh = await page.evaluate(() => window.__studioRec.session().take);
      check(fresh && fresh !== dropped, `restart: a new take records (${dropped} → ${fresh})`);
      check((await scriptY(page)) !== scrolled, 'restart: the script went back to the top');
      await sleep(2000);
      await page.click('.rc [data-a=stop]');
      await page.waitForSelector('.rc[data-mode=after]', { timeout: 120000 });
      if (ROOT) {
        const after = readdirSync(join(ROOT, 'recordings')).filter((n) => !n.startsWith('.'));
        const added = after.filter((n) => !before.includes(n));
        check(added.length === 1 && added[0] === fresh, `restart: exactly one new take in the recordings folder (${added.join(', ')})`);
        check(readdirSync(join(ROOT, '.trash')).some((n) => n.endsWith(dropped)), 'restart: the dropped take is in the trash');
      }
      const unsaved = await api(`/api/projects/${encodeURIComponent(id)}/rec-unfinished`);
      check(!unsaved.takes.length, 'restart: nothing is offered as an unsaved take');
      await page.click('.rc [data-a=close]');
      await ctx.close();
    }

    // ---- the floating bar (script hidden), dark theme, 1440 and 375 ----
    for (const [w, h, theme] of [[1440, 900, 'dark'], [375, 812, 'light'], [375, 812, 'dark']]) {
      const { ctx, page } = await openProject(browser, id, { width: w, height: h, theme });
      if (w === 375) {
        await page.evaluate((pid) => import('/recorder.js').then((r) => r.recordPanel({ id: pid, P: { name: 'Recorder controls check', canvas: {}, layout: {} }, choices: { countdown: 0 }, settingsLink: '#/settings' })), id);
        await page.waitForSelector('.rec-page #rStart');
        await page.waitForFunction(() => document.querySelector('#rCamera')?.options.length > 1, null, { timeout: 20000 });
        if (await page.isVisible('#scrNone')) await page.click('#scrNone');
        await page.selectOption('#rCamera', { index: 1 });
        await page.selectOption('#rMic', { index: 1 });
        await page.waitForFunction(() => document.querySelector('#pvCam')?.srcObject && !document.querySelector('#rStart').disabled);
        await page.click('.rec-page #scTry');
        await page.waitForSelector('.pp-over.try .ppc');
        await shot(page, `08-practice-${w}-${theme}`);
        const fits = await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth && [...document.querySelectorAll('.pp-over.try .ppc-b')].every((b) => b.getBoundingClientRect().right <= innerWidth));
        check(fits, `practice at ${w} px (${theme}): the buttons fit`);
        await page.click('.pp-over.try [data-a=done]');
        await page.click('#rCount [data-c="0"]');
      } else {
        await panel(page);
      }
      await page.click('#rStart');
      await until(page, () => window.__studioRec.session().phase === 'recording');
      await shot(page, `09-recording-script-${w}-${theme}`);
      await page.click('.pp-over [data-a=hide]');
      await page.waitForSelector('body > .rc:not(.docked)');
      await page.click('.rc [data-a=pause]');
      await shot(page, `10-floating-bar-paused-${w}-${theme}`);
      const inView = await page.evaluate(() => { const r = document.querySelector('.rc').getBoundingClientRect(); return r.left >= 0 && r.right <= innerWidth && r.bottom <= innerHeight; });
      check(inView, `floating bar at ${w} px (${theme}) is on screen`);
      await page.click('.rc [data-a=stop]');
      await page.waitForSelector('.rc[data-mode=after]', { timeout: 120000 });
      await shot(page, `11-after-take-${w}-${theme}`);
      await page.click('.rc [data-a=close]');
      await ctx.close();
    }

    // ---- the script's own window ----
    {
      const { ctx, page } = await newPage(browser, { width: 1100, height: 720 });
      await page.goto(`${BASE}/prompter.html?p=${encodeURIComponent(id)}`);
      await page.waitForSelector('.ppw-bar .ppc');
      await page.mouse.move(400, 300);
      await page.waitForSelector('.ppw-bar.on');
      await shot(page, '12-script-window');
      const sp = Number(await page.textContent('[data-v=speed]'));
      await page.click('[data-p=faster]');
      check(Number(await page.textContent('[data-v=speed]')) === sp + 5, 'script window: Faster button');
      await page.keyboard.press('ArrowDown');
      check(Number(await page.textContent('[data-v=speed]')) === sp, 'script window: ↓ still works');
      // A key pressed with a button focused keeps the bar up (keyboard use); a click on the script lets it fade.
      await page.mouse.click(600, 200);
      await page.mouse.move(1000, 100);
      await sleep(3600);
      check(!(await page.$eval('.ppw-bar', (b) => b.classList.contains('on'))), 'script window: the buttons fade when left alone');
      await page.click('#state');
      check(await page.$eval('.ppw-bar', (b) => b.classList.contains('on')), 'script window: clicking the line at the bottom shows them');
      await ctx.close();
    }
  } finally { await browser.close(); }
  if (failures.length) { console.error(`[controls e2e] ${failures.length} failed:\n- ${failures.join('\n- ')}`); process.exit(1); }
  log('all passed');
}
main().catch((e) => { console.error(e); process.exit(1); });
