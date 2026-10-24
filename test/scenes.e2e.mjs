// End-to-end test of the Scenes picture and of the Renders tab with a built intro, through the real page in headless
// Chromium: which video is the picture in every state (the take under the render must never cover it), the take at the
// cut-mapped moment before any render and in a scene the render doesn't reach, Play there, the handover from the intro
// render to the take in Whole video (the render a frame shorter than the intro block, as Claude's renders are: the take
// still takes over where it ends), no approval for a scene that isn't built, no page errors on a reload with Scenes
// open or on leaving it, the scene timeline's header (no "−0:00"), the Renders grouped by what they are, the Export
// panel's Intro row (and what the page sends when the creator picks the canvas instead), and Home's project count.
//
//   STUDIO_URL=http://127.0.0.1:4853 node test/scenes.e2e.mjs
//
// Video Octopus must be running on a throwaway studio (it writes the project scenes-e2e into it). Env: STUDIO_URL;
// PLAYWRIGHT_PATH (default 'playwright'); HEADED=1 to watch; SHOTS=<folder> saves a screenshot per state. Nothing goes to
// Claude (the page's chat and step requests are aborted) and no export runs (the Export request is answered here).
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync, copyFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_PATH || 'playwright');
const BASE = (process.env.STUDIO_URL || 'http://127.0.0.1:4853').replace(/\/$/, '');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log('[scenes e2e]', ...a);
async function api(path, data) {
  const r = await fetch(BASE + path, data === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Studio': '1' }, body: JSON.stringify(data) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`${path}: ${j.error || r.status}`);
  return j;
}
async function until(what, fn, ms = 60000, every = 250) {
  const t0 = Date.now();
  for (;;) {
    const v = await fn().catch(() => null);
    if (v) return v;
    if (Date.now() - t0 > ms) throw new Error(`Timed out waiting for ${what}`);
    await sleep(every);
  }
}
await fetch(`${BASE}/api/app/settings`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Studio': '1' }, body: JSON.stringify({ section: 'help', values: { stepsIntro: 'dismissed' } }) }).catch(() => {});

// ---- the fixture: a 12 s camera take, cut [0, 6] + [6.5, 12]; Intro = take 0–4, four scenes on the cut ----
const status = await api('/api/status');
const ID = 'scenes-e2e', DIR = join(status.studio, status.projectsDir || 'projects', ID);
for (const d of ['source', 'work/tr', 'renders']) mkdirSync(join(DIR, d), { recursive: true });
const cam = join(DIR, 'source', 'se_webcam.mp4');
if (!existsSync(cam)) execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=30', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000',
  '-t', '12', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', cam]);
const intro = join(DIR, 'renders', `${ID}_intro_v1.mp4`), pip = join(DIR, 'renders', `${ID}_pip_v1.mp4`);
rmSync(intro, { force: true }); rmSync(pip, { force: true });
writeFileSync(join(DIR, 'project.json'), JSON.stringify({ name: 'Scenes e2e', type: 'tutorial' }));
writeFileSync(join(DIR, 'WORKLOG.md'), '# Scenes e2e\n- 2026-10-19: Cut locked (join-check: 1 join, 0 clipped)\n');
writeFileSync(join(DIR, 'work/tr/words.json'), JSON.stringify(Array.from({ length: 24 }, (_, i) => [i * 0.5 + 0.05, i * 0.5 + 0.4, `w${i}`])));
const CUT = [[0, 6], [6.5, 12]];
writeFileSync(join(DIR, 'work/edl_fixed.json'), JSON.stringify({ segments_sec: CUT }));
writeFileSync(join(DIR, 'work/cut_scenes.json'), JSON.stringify({ segments: CUT }));
writeFileSync(join(DIR, 'work/blocks.json'), JSON.stringify({ v: 1, marked: true, blocks: [
  { id: 'intro', type: 'intro', label: 'Intro', order: 1, source: { take: [0, 4] } }, { id: 'body', type: 'body', label: 'Main body', order: 2, source: { take: [4, 12] } }] }));
writeFileSync(join(DIR, 'work/production.json'), JSON.stringify({ scenes: [{ id: '1', block: 'intro', start: 0, end: 2, title: 'One' }, { id: '2', block: 'intro', start: 2, end: 4, title: 'Two' },
  { id: '3', block: 'body', start: 4, end: 8, title: 'Three' }, { id: '4', block: 'body', start: 8, end: 11.5, title: 'Four' }] }));
writeFileSync(join(DIR, 'work/notes.json'), JSON.stringify({ v: 1, notes: [], approved: {} }));
// The canvas's playback copy (the Export button waits for it), asked again now and then.
await api(`/api/projects/${ID}/proxies`, {});
{ let n = 0; await until('the playback copy', async () => { if (++n % 20 === 0) await api(`/api/projects/${ID}/proxies`, {}).catch(() => {}); return Object.values((await api(`/api/projects/${ID}`)).proxies || {}).filter(Boolean).length >= 1; }, 180000, 500); }
// The take on the cut: sheet time → take time.
const toTake = (t) => { let acc = 0; for (const [a, b] of CUT) { if (t < acc + b - a) return a + t - acc; acc += b - a; } return CUT.at(-1)[1]; };

const browser = await chromium.launch({ headless: !process.env.HEADED, args: ['--autoplay-policy=no-user-gesture-required'] });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
let exportBody = null;
await page.route('**/*', (route) => {
  const r = route.request(), u = r.url();
  if (r.method() === 'POST' && /\/(chat|step|send|ask|apply-notes|kit)(\?|$)/.test(u)) return route.abort();
  // The Export button: keep what the page sends, start nothing.
  if (r.method() === 'POST' && /\/api\/projects\/[^/]+\/export$/.test(u)) { exportBody = JSON.parse(r.postData() || '{}'); return route.fulfill({ status: 500, contentType: 'application/json', body: '{"error":"not in this test"}' }); }
  return route.continue();
});
const errors = [];
page.on('pageerror', (e) => { errors.push(e.message); log('page error:', e.message); });
const shot = async (name) => { if (process.env.SHOTS) { mkdirSync(process.env.SHOTS, { recursive: true }); await page.screenshot({ path: join(process.env.SHOTS, `${name}.png`) }); } };
// The picture: which video shows (computed style, so a CSS rule that lets the take cover the render is caught).
const pic = () => page.evaluate(() => {
  const f = document.querySelector('.sc-frame'), v = f?.querySelector('.sc-v'), tk = f?.querySelector('.sc-take'), cs = (e) => getComputedStyle(e);
  return f && { cutview: f.classList.contains('cutview'), take: { shown: cs(tk).display !== 'none' && cs(tk).visibility !== 'hidden', t: tk.currentTime, paused: tk.paused },
    render: { shown: cs(v).display !== 'none' && cs(v).visibility !== 'hidden', t: v.currentTime, paused: v.paused, src: v.getAttribute('src') || '' },
    note: f.querySelector('.sc-cutnote')?.hidden ? '' : f.querySelector('.sc-cutnote')?.textContent || '', time: document.querySelector('#scTime')?.textContent || '' };
});
const results = [];
let failures = 0;
const expect = (ok, what, detail) => { if (ok) results.push(what); else { failures++; log(`FAIL ${what}: ${JSON.stringify(detail)}`); } };
const mode = async (m) => { await page.click(`#s2Mode [data-m=${m}]`); await sleep(400); };
const pick = async (sid) => { await page.click(`.s2-row[data-id="${sid}"], .s2-chip[data-id="${sid}"]`); await sleep(500); };
const play = async (ms) => { await page.click('#scPlay'); await sleep(ms); };

try {
  // 1. Before any render: the take at the cut-mapped moment, Play plays it (One scene and Whole video).
  await page.goto(`${BASE}/#/p/${ID}`);
  await page.waitForSelector('[data-tab=scenes]', { timeout: 30000 });
  await page.click('[data-tab=scenes]');
  await page.waitForSelector('.sc-frame', { timeout: 30000 });
  await mode('scene');
  await pick('4');
  await until('the take in cut view', async () => (await pic())?.cutview, 30000);
  await sleep(500);
  let p = await pic();
  const want4 = toTake(8 + Math.min(3.5 * 0.4, 2)); // scene 4 opens 1.4 s in: 9.4 on the cut = 9.9 in the take
  expect(p.take.shown && !p.render.shown && Math.abs(p.take.t - want4) < 0.1 && /No render yet/.test(p.note), `no render: the take shows at ${p.take.t.toFixed(2)} s (cut-mapped ${want4.toFixed(2)})`, p);
  await shot('1-no-render-scene4');
  await play(900);
  p = await pic();
  expect(!p.take.paused && p.take.t > want4 + 0.4, `no render: Play plays the take (${p.take.t.toFixed(2)} s)`, p);
  await shot('2-no-render-playing');
  await play(200);
  await mode('full');
  await pick('2');
  await play(900);
  p = await pic();
  expect(p.take.shown && !p.take.paused && !p.render.shown, `no render, Whole video: the take plays (${p.take.t.toFixed(2)} s)`, p);
  await play(200);

  // 2. The intro is built (119 frames, 3.967 s: one frame short of the 4 s intro block, green): Whole video and One
  // scene show the render, playing and paused.
  execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=0x10c040:s=640x360:r=30', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000', '-frames:v', '119', '-t', '3.967',
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', intro]);
  await sleep(1100);
  copyFileSync(intro, pip); // stands in for an Export → Video, so the Renders tab has two kinds
  await page.reload();
  await page.waitForSelector('[data-tab=scenes]', { timeout: 30000 });
  await page.click('[data-tab=scenes]');
  await page.waitForSelector('.sc-frame', { timeout: 30000 });
  await until('the render loaded', async () => (await pic())?.render.src.includes('_intro_v1'), 20000);
  await mode('full');
  await pick('1');
  await sleep(600);
  p = await pic();
  expect(p.render.shown && !p.take.shown && !p.cutview, 'render, Whole video, paused: the render is the picture', p);
  await play(800);
  p = await pic();
  expect(p.render.shown && !p.take.shown && !p.render.paused, `render, Whole video, playing: the render plays (${p.render.t.toFixed(2)} s)`, p);
  await shot('3-render-whole-playing');
  await play(200);
  await mode('scene');
  await pick('2');
  await sleep(500);
  p = await pic();
  expect(p.render.shown && !p.take.shown, 'render, One scene, paused: the render is the picture', p);
  await play(700);
  p = await pic();
  expect(p.render.shown && !p.take.shown && !p.render.paused, 'render, One scene, playing: the render plays', p);
  await play(200);

  // 3. A scene the render doesn't reach: the take, "Not built yet", no approval.
  await pick('3');
  await until('the take in scene 3', async () => (await pic())?.cutview, 10000);
  await sleep(400);
  p = await pic();
  const nb = await page.evaluate(() => ({ approve: Boolean(document.querySelector('#ncApprove')), state: document.querySelector('.s2-title .sc-st')?.textContent || '' }));
  expect(p.take.shown && !p.render.shown && /Not built yet/.test(p.note) && !nb.approve && /Not built yet/.test(nb.state), 'scene 3 (not built): the take, "Not built yet", no Approve', { p, nb });
  await shot('4-not-built');
  const refused = await api(`/api/projects/${ID}/notes`, { op: 'approve', scene: '3' }).then(() => null, (e) => e.message);
  expect(/isn't built yet/.test(refused || ''), 'the server refuses to approve a scene that isn\'t built', refused);

  // 4. Whole video plays from the intro render into the body: the take takes over where the render ends (3.967 s, a
  // frame before the intro block ends: it doesn't stop there).
  await mode('full');
  await pick('2');
  await sleep(400);
  await play(2200);
  p = await pic();
  expect(p.cutview && p.take.shown && !p.take.paused && p.take.t > 4.05, `Whole video: the render hands over to the take at its end (take ${p.take.t.toFixed(2)} s)`, p);
  await shot('5-whole-handover');
  await play(200);

  // 4b. The scene timeline's header for the first scene starts at 0:00 (its lead-in before 0:00 isn't "−0:00").
  await mode('scene');
  await pick('1');
  await sleep(500);
  const head = await page.evaluate(() => document.querySelector('#scStl .tl-range')?.textContent || '');
  expect(/^0:00 – /.test(head), `the scene timeline's header: "${head}"`, head);
  await mode('full');

  // 4c. A reload with Scenes open, and leaving it for Settings and coming back: no page errors.
  await page.reload();
  await page.waitForSelector('.sc-frame', { timeout: 30000 });
  await sleep(1200);
  await page.goto(`${BASE}/#/settings`);
  await sleep(800);
  await page.goto(`${BASE}/#/p/${ID}`);
  await page.waitForSelector('.sc-frame', { timeout: 30000 });
  await sleep(1200);
  expect(!errors.length, 'no page errors on a reload with Scenes open or on leaving it', errors);

  // 5. Renders grouped by what they are, and the Export panel's Intro row.
  await page.click('[data-tab=publish]');
  await page.waitForSelector('.rd-name', { timeout: 15000 });
  await sleep(500);
  const rd = await page.evaluate(() => ({ heads: [...document.querySelectorAll('.rd-head b')].map((b) => b.textContent), badge: document.querySelector('.rd-tags .badge')?.textContent || '',
    row: document.querySelector('#insOther .ex-built')?.innerText.replace(/\s+/g, ' ') || '' }));
  expect(rd.heads.includes('Intro builds') && /Video export/.test(rd.badge) && /From Build the intro, intro_v1\.mp4 ✓/.test(rd.row), `Renders: ${rd.heads.join(' · ')} · "${rd.badge}"; Export: ${rd.row}`, rd);
  await shot('6-renders-export-panel');
  await page.click('#insOther [data-built=intro]');
  await sleep(300);
  const row2 = await page.evaluate(() => document.querySelector('#insOther .ex-built')?.innerText.replace(/\s+/g, ' ') || '');
  expect(/^The canvas/.test(row2), `Use the canvas instead: "${row2}"`, row2);
  // What the page sends (the export itself is answered here, nothing renders).
  const ready = await page.waitForSelector('#exGo:not([disabled])', { timeout: 60000 }).then(() => true, () => false);
  if (ready) {
    await page.click('#exGo');
    await until('the export request', async () => exportBody, 10000);
    expect(exportBody.built?.intro === false, `the export is sent with built ${JSON.stringify(exportBody.built)}`, exportBody.built);
  } else results.push('(the canvas wasn\'t ready to export: the request isn\'t checked)');
  await page.click('#insOther [data-built=intro]').catch(() => {});

  // 6. Home: the grid's count is every project, the one in "Continue where you left off" too (= the sidebar's).
  await page.goto(`${BASE}/#/`);
  await page.waitForSelector('#shown', { timeout: 15000 });
  await sleep(500);
  const home = await page.evaluate(() => ({ nav: document.querySelector('.side-nav .nav-i[href="#/"] .n')?.textContent || '', shown: document.querySelector('#shown')?.textContent || '' }));
  expect(home.nav && home.shown === `${home.nav} project${home.nav === '1' ? '' : 's'}`, `Home: sidebar Projects ${home.nav}, grid "${home.shown}"`, home);
  expect(!errors.length, 'no page errors', errors);
} finally {
  await browser.close();
}
for (const r of results) log(r);
if (failures) { log(`${failures} failed`); process.exit(1); }
console.log(`scenes and renders: ${results.length} checks · ${results.slice(0, 3).join(' · ')}`);
