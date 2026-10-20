// End-to-end test of the record panel's script (web/prompter.js), through the real UI, in headless Chromium with fake
// devices (nothing real is opened): put a script in, try it, its own window following a take, the script scrolling
// over Video Octopus during a mic-only take and its Stop button, then removing it.
//
//   STUDIO_URL=http://127.0.0.1:4821 STUDIO_PROJECT=<project id> node test/prompter.e2e.mjs
//
// Env: STUDIO_URL; STUDIO_PROJECT (default: a new project "studio-test-e2e-script"); PLAYWRIGHT_PATH; SHOTS=<dir> to
// save screenshots; HEADED=1 to watch. Exits 0 only when every check passes.
import { createRequire } from 'node:module';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_PATH || 'playwright');
const BASE = (process.env.STUDIO_URL || 'http://127.0.0.1:4821').replace(/\/$/, '');
const SHOTS = process.env.SHOTS || '';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log('[script e2e]', ...a);
const failures = [];
const check = (ok, text) => { if (ok) log(`ok   ${text}`); else { failures.push(text); console.error('[script e2e] FAIL', text); } };

async function api(path, data) {
  const r = await fetch(BASE + path, data === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Studio': '1' }, body: JSON.stringify(data) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`${path}: ${j.error || r.status}`);
  return j;
}
const scriptFile = async (id) => { const r = await fetch(`${BASE}/api/projects/${encodeURIComponent(id)}/files/script.md`, { cache: 'no-store' }); return r.ok ? r.text() : null; };
const shot = async (page, name) => { if (SHOTS) { mkdirSync(SHOTS, { recursive: true }); await page.screenshot({ path: join(SHOTS, `${name}.png`) }); } };
const offset = (page, sel) => page.$eval(sel, (el) => new DOMMatrix(getComputedStyle(el).transform).m42);

const SCRIPT = `[calm] Welcome to the test script. Every line of it should scroll past the reading line while the take runs.

[curious] Cues in brackets show dim, so nobody reads them out by mistake.

[long pause]

${Array.from({ length: 40 }, (_, i) => `Line ${i + 1} of the script, long enough to keep scrolling for a while.`).join('\n')}`;

await fetch(`${BASE}/api/app/settings`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Studio': '1' }, body: JSON.stringify({ section: 'help', values: { stepsIntro: 'dismissed' } }) }).catch(() => {});
let id = process.env.STUDIO_PROJECT;
if (!id) id = (await api('/api/projects', { name: 'studio-test-e2e-script', type: 'tutorial' })).id;

const browser = await chromium.launch({
  headless: !process.env.HEADED,
  args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', '--autoplay-policy=no-user-gesture-required'],
});
try {
  const ctx = await browser.newContext({ permissions: ['camera', 'microphone'], viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => { failures.push(`page error: ${e.message}`); console.error('[page error]', e.message); });
  await page.goto(`${BASE}/?fakeScreen=1#/p/${encodeURIComponent(id)}`);
  await page.waitForSelector('#recBtn:not([disabled])');
  await page.waitForFunction(() => document.querySelector('#recText')?.textContent === 'Record');

  // ---- the Script card: Put a script ----
  await page.click('#recBtn');
  await page.waitForSelector('.rec-page #rStart');
  await page.waitForFunction(() => document.querySelector('#rScript #scEdit'));
  check((await page.textContent('#scEdit')).trim() === 'Put a script', 'an empty project offers "Put a script"');
  await page.click('#scEdit');
  await page.waitForSelector('.pp-modal #scText');
  await page.fill('#scText', SCRIPT);
  check(/\d+ words · about \d+ min/.test(await page.textContent('#scCount')), `the box counts the words (${await page.textContent('#scCount')})`);
  await shot(page, '1-edit');
  await page.keyboard.press('Escape');
  check(!(await page.$('.pp-modal')) && Boolean(await page.$('.rec-page')), 'Escape closes the script box and leaves the record panel open');
  check((await scriptFile(id)) === null, 'nothing saved on Escape');
  await page.click('#scEdit');
  await page.fill('#scText', SCRIPT);
  await page.click('#scSave');
  await page.waitForFunction(() => document.querySelector('#rScript .rp-sc-sum'));
  check((await scriptFile(id)) === `${SCRIPT}\n`, 'Save writes script.md in the project');
  const sum = await page.textContent('#rScript .rp-sc-sum');
  check(/Welcome to the test script/.test(sum) && !/\[calm\]/.test(sum) && /\d+ words/.test(sum), `the card shows the first line without its cue, and the length (${sum.replace(/\s+/g, ' ').trim()})`);
  await shot(page, '2-card');

  // ---- Try it: a practice run ----
  await page.click('#scTry');
  await page.waitForSelector('.pp-over.try .pp-text');
  check((await page.$$('.pp-over.try .pp-cue')).length === 3, 'the cues are drawn as cues');
  const y0 = await offset(page, '.pp-over.try .pp-text');
  await sleep(700);
  check(Math.abs((await offset(page, '.pp-over.try .pp-text')) - y0) < 1, 'practice waits for Space');
  await page.keyboard.press(' ');
  await sleep(1200);
  const y1 = await offset(page, '.pp-over.try .pp-text');
  check(y1 < y0 - 20, `Space starts it scrolling (${Math.round(y0)} → ${Math.round(y1)})`);
  await page.keyboard.press('ArrowUp');
  check(await page.evaluate(() => localStorage.getItem('studio.prompter.speed')) === '65', 'the arrow keys change the speed, and it is kept');
  await page.keyboard.press('ArrowDown');
  const mirrored = await page.$eval('.pp-over.try .pp-stage', (el) => el.classList.contains('flipH'));
  check(!mirrored, 'not mirrored by default (a teleprompter flips it itself)');
  await shot(page, '3-try');
  await page.keyboard.press('Escape');
  check(!(await page.$('.pp-over')) && Boolean(await page.$('.rec-page')), 'Escape ends practice and leaves the record panel open');

  // ---- its own window follows a take; Video Octopus then shows nothing over itself ----
  const [win] = await Promise.all([ctx.waitForEvent('page'), page.click('#scWin')]);
  await win.waitForSelector('.pp-text');
  await win.waitForFunction(() => /Waiting for the recording/.test(document.getElementById('state').textContent));
  check(/Welcome to the test script/.test(await win.textContent('.pp-text')), 'its own window shows the script');
  await sleep(300);
  const pick = async (kind) => {
    await page.waitForFunction(() => document.querySelector('#rMic')?.options.length > 1, null, { timeout: 20000 });
    if (await page.isVisible('#scrNone')) await page.click('#scrNone');
    await page.selectOption('#rCamera', 'none');
    await page.selectOption('#rMic', { index: 1 });
    await page.waitForFunction(() => document.querySelector('#rPerm')?.hidden !== false && !document.querySelector('#rStart').disabled);
    await page.click('#rCount [data-c="0"]');
    if (await page.$('#rTarget')) await page.click('#rTarget [data-t="replace"]');
    log(`recording "${await page.textContent('#rStartL')}" (${kind})`);
  };
  await pick('own window');
  const w0 = await offset(win, '.pp-text');
  await page.click('#rStart');
  await page.waitForFunction(() => /^Stop/.test(document.querySelector('#recText')?.textContent || ''), null, { timeout: 15000 });
  await win.waitForFunction(() => /Recording/.test(document.getElementById('state').textContent), null, { timeout: 5000 });
  await sleep(1500);
  check((await offset(win, '.pp-text')) < w0 - 20, 'its own window scrolls once the take starts');
  check(!(await page.$('.pp-over')), 'Video Octopus shows no script over itself while its own window is open');
  await page.click('#recBtn');
  await page.waitForFunction(() => document.querySelector('#recText')?.textContent === 'Record', null, { timeout: 120000 });
  await win.waitForFunction(() => /stopped/.test(document.getElementById('state').textContent), null, { timeout: 5000 });
  const w1 = await offset(win, '.pp-text'); await sleep(600);
  check(Math.abs((await offset(win, '.pp-text')) - w1) < 1, 'its own window stops with the take');
  await win.close();
  await sleep(300);

  // ---- in Video Octopus: scrolls with the take, Space pauses it, its Stop button stops the take ----
  await page.click('#recBtn');
  await page.waitForSelector('.rec-page #rStart');
  await page.waitForFunction(() => document.querySelector('#rScript .rp-sc-sum'));
  await pick('in Video Octopus');
  await page.click('#rStart');
  await page.waitForSelector('.pp-over:not(.try) .pp-text');
  await page.waitForSelector('.pp-over.live', { timeout: 15000 });
  const s0 = await offset(page, '.pp-over .pp-text');
  await sleep(1500);
  const s1 = await offset(page, '.pp-over .pp-text');
  check(s1 < s0 - 20, `the script scrolls over Video Octopus during the take (${Math.round(s0)} → ${Math.round(s1)})`);
  check(/Recording 0:0\d/.test(await page.textContent('.pp-clock')), `the bar shows the take's clock (${await page.textContent('.pp-clock')})`);
  await shot(page, '4-take');
  await page.keyboard.press(' ');
  const p0 = await offset(page, '.pp-over .pp-text'); await sleep(700);
  check(Math.abs((await offset(page, '.pp-over .pp-text')) - p0) < 1, 'Space pauses the script');
  check(/^Stop/.test(await page.textContent('#recText')), 'and the take goes on');
  await page.click('.pp-over [data-a=stop]');
  await page.waitForFunction(() => !document.querySelector('.pp-over'), null, { timeout: 15000 });
  await page.waitForFunction(() => document.querySelector('#recText')?.textContent === 'Record', null, { timeout: 120000 });
  check(true, 'the Stop button stops the take and the script goes away');

  // ---- Remove ----
  await page.click('#recBtn');
  await page.waitForSelector('#rScript #scEdit');
  await page.click('#scEdit');
  await page.click('#scDel');
  await page.waitForFunction(() => document.querySelector('#rScript #scEdit')?.textContent.trim() === 'Put a script');
  check((await scriptFile(id)) === null, 'Remove deletes script.md');
  await page.keyboard.press('Escape');
  await ctx.close();

  // ---- the plugged-in mic: the fake devices renamed like a Mac with a USB mic, the built-in one the default ----
  const ctx2 = await browser.newContext({ permissions: ['camera', 'microphone'], viewport: { width: 1440, height: 900 } });
  await ctx2.addInitScript(() => {
    const real = navigator.mediaDevices.enumerateDevices.bind(navigator.mediaDevices);
    const names = { 'Fake Default Audio Input': 'Default - MacBook Pro Microphone (Built-in)', 'Fake Audio Input 1': 'MacBook Pro Microphone (Built-in)', 'Fake Audio Input 2': 'USB Podcast Mic (1a2b:3c4d)' };
    navigator.mediaDevices.enumerateDevices = async () => (await real()).map((x) => ({ deviceId: x.deviceId, groupId: x.groupId, kind: x.kind, label: names[x.label] || x.label }));
  });
  const p2 = await ctx2.newPage();
  p2.on('pageerror', (e) => { failures.push(`page error: ${e.message}`); console.error('[page error]', e.message); });
  await p2.goto(`${BASE}/?fakeScreen=1#/p/${encodeURIComponent(id)}`);
  await p2.waitForSelector('#recBtn:not([disabled])');
  await p2.click('#recBtn');
  await p2.waitForSelector('.rec-page #rStart');
  await p2.waitForFunction(() => document.querySelector('#rMic')?.options.length > 2, null, { timeout: 20000 });
  await p2.selectOption('#rMic', 'default');
  await p2.waitForFunction(() => document.querySelector('#micSug') && !document.querySelector('#micSug').hidden, null, { timeout: 10000 }).catch(() => {});
  const sug = await p2.$eval('#micSug', (el) => ({ shown: !el.hidden, text: el.textContent }));
  check(sug.shown && /USB Podcast Mic is plugged in/.test(sug.text) && !/1a2b/.test(sug.text), `on the built-in mic, the panel offers the plugged-in one (${sug.text.trim()})`);
  await shot(p2, '5-mic');
  await p2.click('#micSugUse');
  await p2.waitForFunction(() => document.querySelector('#micSug').hidden, null, { timeout: 10000 }).catch(() => {});
  const now = await p2.$eval('#rMic', (el) => el.selectedOptions[0]?.textContent || '');
  check(/^USB Podcast Mic$/.test(now.trim()) && await p2.$eval('#micSug', (el) => el.hidden), `Use it switches to it (${now})`);
  await ctx2.close();

  // ---- a screen the computer won't record: the note says where to allow it; No screen clears it and Start works ----
  const ctx3 = await browser.newContext({ permissions: ['camera', 'microphone'], viewport: { width: 1440, height: 900 } });
  const p3 = await ctx3.newPage();
  p3.on('pageerror', (e) => { failures.push(`page error: ${e.message}`); console.error('[page error]', e.message); });
  await p3.goto(`${BASE}/?fakeScreen=refused#/p/${encodeURIComponent(id)}`);
  await p3.waitForSelector('#recBtn:not([disabled])');
  await p3.click('#recBtn');
  await p3.waitForSelector('.rec-page #rStart');
  await p3.waitForFunction(() => document.querySelector('#rCamera')?.options.length > 1 && document.querySelector('#rMic')?.options.length > 1, null, { timeout: 20000 });
  await p3.selectOption('#rCamera', { index: 1 });
  await p3.selectOption('#rMic', { index: 1 });
  await p3.waitForFunction(() => document.querySelector('#pvCam')?.srcObject);
  await p3.click('#scrPick');
  await p3.waitForFunction(() => !document.querySelector('#rPerm').hidden);
  const note = await p3.textContent('#rPerm');
  check(/couldn't record the screen/.test(note) && /Try again/.test(note), `a refused screen says what to do, with Try again (${note.trim().slice(0, 90)}…)`);
  if (await p3.isVisible('#scrNone')) { await p3.click('#scrNone'); check(await p3.$eval('#rPerm', (el) => el.hidden), 'No screen clears the screen note'); }
  await p3.click('#rCount [data-c="0"]');
  check(/Record camera/.test(await p3.textContent('#rStartL')), `with no screen the take is the camera (${await p3.textContent('#rStartL')})`);
  await p3.click('#rStart');
  const started = await p3.waitForFunction(() => /^Stop/.test(document.querySelector('#recText')?.textContent || ''), null, { timeout: 15000 }).then(() => true, () => false);
  check(started, 'then Start records (the camera take)');
  if (started) { await sleep(1500); await p3.click('#recBtn'); await p3.waitForFunction(() => document.querySelector('#recText')?.textContent === 'Record', null, { timeout: 120000 }); }
  await ctx3.close();

  // ---- where a take goes: "Add as a layer" remembered, a new project with no take, two takes back to back ----
  await api('/api/app/settings', { section: 'recorder', values: { target: 'layer' } });
  const id4 = (await api('/api/projects', { name: 'studio-test-e2e-target', type: 'tutorial' })).id;
  const ctx4 = await browser.newContext({ permissions: ['camera', 'microphone'], viewport: { width: 1440, height: 900 } });
  const p4 = await ctx4.newPage();
  p4.on('pageerror', (e) => { failures.push(`page error: ${e.message}`); console.error('[page error]', e.message); });
  await p4.goto(`${BASE}/?fakeScreen=1#/p/${encodeURIComponent(id4)}`);
  await p4.waitForSelector('#recBtn:not([disabled])');
  const camTake = async () => {
    await p4.click('#recBtn');
    await p4.waitForSelector('.rec-page #rStart');
    await p4.waitForFunction(() => document.querySelector('#rCamera')?.options.length > 1, null, { timeout: 20000 });
    if (await p4.isVisible('#scrNone')) await p4.click('#scrNone');
    await p4.selectOption('#rCamera', { index: 1 });
    await p4.waitForFunction(() => document.querySelector('#pvCam')?.srcObject);
    await p4.click('#rCount [data-c="0"]');
    const choice = Boolean(await p4.$('#rTarget'));
    await p4.click('#rStart');
    await p4.waitForFunction(() => /^Stop/.test(document.querySelector('#recText')?.textContent || ''), null, { timeout: 15000 });
    await sleep(1500);
    await p4.click('#recBtn');
    await p4.waitForFunction(() => document.querySelector('#recText')?.textContent === 'Record', null, { timeout: 120000 });
    return choice;
  };
  const first = await camTake();
  const P4 = await api(`/api/projects/${encodeURIComponent(id4)}`);
  check(!first && P4.canvas?.cam && !(P4.layout?.layers || []).length, `no take yet: no choice shown, and the take is the take even with "layer" remembered (${P4.canvas?.cam || 'no take'})`);
  // Straight away, before the page has heard about the first take: the panel asks Video Octopus, so the choice shows.
  await p4.click('#recBtn');
  await p4.waitForSelector('.rec-page #rStart');
  check(Boolean(await p4.$('#rTarget')), 'right after a take, the panel shows "Where the take goes"');
  await p4.keyboard.press('Escape');
  await ctx4.close();
  await api('/api/app/settings', { section: 'recorder', values: { target: 'replace' } });

  // ---- a mic picked and Start pressed at once: Start waits for the mic instead of calling it missing ----
  const ctx5 = await browser.newContext({ permissions: ['camera', 'microphone'], viewport: { width: 1440, height: 900 } });
  const p5 = await ctx5.newPage();
  p5.on('pageerror', (e) => { failures.push(`page error: ${e.message}`); console.error('[page error]', e.message); });
  await p5.goto(`${BASE}/?fakeScreen=1#/p/${encodeURIComponent(id4)}`);
  await p5.waitForSelector('#recBtn:not([disabled])');
  await p5.click('#recBtn');
  await p5.waitForSelector('.rec-page #rStart');
  await p5.waitForFunction(() => document.querySelector('#rMic')?.options.length > 2 && document.querySelector('#pvCam')?.srcObject, null, { timeout: 20000 });
  if (await p5.isVisible('#scrNone')) await p5.click('#scrNone');
  await p5.click('#rCount [data-c="0"]');
  await p5.selectOption('#rMic', { index: 2 });
  await p5.click('#rStart'); // no wait: the mic is still reopening
  const went = await p5.waitForFunction(() => /^Stop/.test(document.querySelector('#recText')?.textContent || ''), null, { timeout: 15000 }).then(() => true, () => false);
  const why = went ? '' : await p5.$eval('#rPerm', (el) => (el.hidden ? '(no note)' : el.textContent)).catch(() => '');
  check(went, `a mic picked and Start pressed at once: the take starts${why ? ` (it said: ${why.trim().slice(0, 80)})` : ''}`);
  if (went) { await sleep(1000); await p5.click('#recBtn'); await p5.waitForFunction(() => document.querySelector('#recText')?.textContent === 'Record', null, { timeout: 120000 }); }
  await ctx5.close();
} catch (e) {
  failures.push(e.message);
  console.error('[script e2e] FAIL', e.message);
} finally {
  await browser.close();
}
if (failures.length) { console.error(`[script e2e] ${failures.length} failed`); process.exit(1); }
log('all checks passed');
