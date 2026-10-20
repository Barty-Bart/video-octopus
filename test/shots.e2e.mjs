// End-to-end test of the shot-by-shot export, through the real page, in headless Chromium: the page's own Export button
// sends one set of canvas PNG layers per shot look, and the MP4 it makes is compared with what the canvas draws for
// lookAt(t) (web/layout.js) at a few moments: in each shot, and inside a crossfade (the two looks blended by
// transitionAt's p). The take is the export test pattern (a blue screen with a red band along the top and a yellow one
// at the bottom; SMPTE bars on the camera; a 440 Hz tone as the voice).
//
//   STUDIO_URL=http://127.0.0.1:4853 node test/shots.e2e.mjs
//
// Video Octopus must be running on a throwaway studio (it writes two projects, shots-e2e and shots-e2e-look, into it).
// Env: STUDIO_URL; PLAYWRIGHT_PATH (default 'playwright'); HEADED=1 to watch. Nothing is recorded and no chat is sent
// (the page's chat and step requests are aborted). Exits 0 only when every compared point matches.
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync, readFileSync, copyFileSync } from 'node:fs';
import { join } from 'node:path';

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_PATH || 'playwright');
const BASE = (process.env.STUDIO_URL || 'http://127.0.0.1:4853').replace(/\/$/, '');

// The first-time help (the steps' "How a video gets made here") opens over a fresh studio's first project page and
// would catch the clicks below: say it's been seen, the way pressing Got it does.
await fetch(`${BASE}/api/app/settings`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Studio': '1' }, body: JSON.stringify({ section: 'help', values: { stepsIntro: 'dismissed' } }) }).catch(() => {});
const L = await import(new URL('../web/layout.js', import.meta.url).href);
const X = await import(new URL('../web/exportshots.js', import.meta.url).href);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log('[shots e2e]', ...a);
async function api(path, data) {
  const r = await fetch(BASE + path, data === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Studio': '1' }, body: JSON.stringify(data) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`${path}: ${j.error || r.status}`);
  return j;
}
async function until(what, fn, ms = 90000, every = 300) {
  const t0 = Date.now();
  for (;;) {
    const v = await fn().catch(() => null);
    if (v) return v;
    if (Date.now() - t0 > ms) throw new Error(`Timed out waiting for ${what}`);
    await sleep(every);
  }
}

// ---- the fixture: the take, and a second project with the same take and no shots (to draw one look at a time) ----
const status = await api('/api/status');
const ROOT = join(status.studio, status.projectsDir || 'projects');
const ID = 'shots-e2e', LOOK = 'shots-e2e-look', SECS = 12;
const DIR = join(ROOT, ID), LDIR = join(ROOT, LOOK);
const SIZE = [1280, 720];
for (const d of [DIR, LDIR]) mkdirSync(join(d, 'source'), { recursive: true });
const screenF = join(DIR, 'source', 'e2e_screen.mov'), camF = join(DIR, 'source', 'e2e_webcam.mov');
if (!existsSync(camF)) {
  const [w, h] = SIZE;
  execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', `color=c=0x2050c0:s=${w}x${h}:r=30,drawbox=x=0:y=0:w=${w}:h=${h / 10}:color=0xff0000:t=fill,drawbox=x=0:y=${h - h / 12}:w=${w}:h=${h / 12}:color=0xffff00:t=fill`,
    '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000', '-t', String(SECS), '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'pcm_s16le', screenF]);
  execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', `smptebars=size=${w}x${h}:rate=30`, '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000',
    '-t', String(SECS), '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'pcm_s16le', camF]);
}
for (const f of ['e2e_screen.mov', 'e2e_webcam.mov']) if (!existsSync(join(LDIR, 'source', f))) copyFileSync(join(DIR, 'source', f), join(LDIR, 'source', f));
const baseLayout = L.normalize({ preset: 'pip', cam: { border: '#12ab34', borderW: 10, shadow: false } }, 'tutorial');
writeFileSync(join(DIR, 'project.json'), JSON.stringify({ name: 'Shots e2e', type: 'tutorial', layout: baseLayout }));
writeFileSync(join(LDIR, 'project.json'), JSON.stringify({ name: 'Shots e2e (one look)', type: 'tutorial', layout: baseLayout }));
mkdirSync(join(DIR, 'work'), { recursive: true });
// Shots: the video's PiP; 4 s: the camera hidden and the screen zoomed in (the red band goes); 8 s: back to PiP with a
// 0.5 s crossfade; 10 s: Claude's proposal (Camera), which the export must leave out.
writeFileSync(join(DIR, 'work/shots.json'), JSON.stringify({ v: 1, shots: [
  { id: 's1', start: 0 },
  { id: 's2', start: 4, name: 'Demo', look: { hidden: ['cam'], screen: { zoom: 1.4, focus: { x: 0.5, y: 0.5 } } } },
  { id: 's3', start: 8, in: { type: 'fade', dur: 0.5 } },
  { id: 's4', start: 10, look: { preset: 'camera' }, by: 'claude', status: 'proposed' }] }));
await api(`/api/projects/${ID}/proxies`, {});
await api(`/api/projects/${LOOK}/proxies`, {});
// Wait until both copies exist (a listed copy can still be null), asking again now and then: a request made the moment
// a new project folder appears can come too early for it.
const copies = async (id, extra = () => true) => { let n = 0; return until(`playback copies (${id})`, async () => {
  if (++n % 20 === 0) await api(`/api/projects/${id}/proxies`, {}).catch(() => {});
  const v = await api(`/api/projects/${id}`); return Object.values(v.proxies || {}).filter(Boolean).length >= 2 && extra(v) ? v : null; }, 180000); };
const P = await copies(ID, (v) => v.export?.dims?.cam);
await copies(LOOK);
const dims = P.export.dims, kept = X.keptShots(P.shots);
if (kept.length !== 3) throw new Error(`kept shots: ${kept.map((s) => s.id)}`);

// ---- the page ----
const browser = await chromium.launch({ headless: !process.env.HEADED, args: ['--autoplay-policy=no-user-gesture-required'] });
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
await page.route('**/*', (route) => {
  const r = route.request(), u = r.url();
  if (r.method() === 'POST' && /\/(chat|step|send|ask)(\?|$)/.test(u)) return route.abort();
  return route.continue();
});
page.on('pageerror', (e) => log('page error:', e.message));
const ready = (id) => page.waitForFunction(() => {
  const vids = [...document.querySelectorAll('video.hidden-media')];
  return document.querySelector('#stage') && vids.length >= 2 && vids.every((v) => v.readyState >= 2);
}, null, { timeout: 90000 }).catch(async (e) => {
  // Say what the page had, so a timeout explains itself.
  const seen = await page.evaluate(() => ({ hash: location.hash, stage: Boolean(document.querySelector('#stage')), modal: document.querySelector('#modal:not([hidden])')?.textContent?.slice(0, 80) || null,
    text: (document.querySelector('main, .project, body')?.innerText || '').replace(/\s+/g, ' ').slice(0, 400), vids: [...document.querySelectorAll('video')].map((v) => ({ cls: v.className, src: (v.currentSrc || v.src || '').replace(location.origin, '').slice(0, 90), ready: v.readyState, net: v.networkState, err: v.error?.code || null })) })).catch(() => null);
  throw new Error(`${id}: the canvas videos never got ready: ${JSON.stringify(seen)}`);
});

let failures = 0;
const results = [];
try {
  // 1. Export through the page's own button: it sends a PNG set per look (pngs.looks, by sceneKey).
  await page.goto(`${BASE}/#/p/${encodeURIComponent(ID)}`);
  await ready(ID);
  await page.click('#exportBtn');
  await page.waitForSelector('#exGo:not([disabled])', { timeout: 30000 });
  const shotsRow = await page.locator('.ex dt:has-text("Shots") + dd').textContent().catch(() => null);
  log('Export panel, Shots:', shotsRow?.trim());
  const sent = page.waitForResponse((r) => r.request().method() === 'POST' && /\/export$/.test(r.url()));
  await page.click('#exGo');
  const res = await sent;
  const body = JSON.parse(res.request().postData()), started = await res.json();
  if (!started.out) throw new Error(`export: ${JSON.stringify(started)}`);
  const want = new Set(X.exportLooks(L.normalize(P.layout, P.type), P.shots).map((l) => X.sceneKey(L.compose(l, dims))));
  const got = Object.keys(body.pngs.looks || {});
  if (got.length !== want.size || !got.every((k) => want.has(k))) { failures++; log(`FAIL looks sent: ${got.length}, wanted ${want.size}`); }
  results.push(`page sent ${got.length} look PNG sets${shotsRow ? ` (panel: ${shotsRow.trim().split('Each')[0].trim()})` : ''}`);
  const out = started.out;
  await until('the export', async () => !(await api(`/api/projects/${ID}`)).export.running && existsSync(join(DIR, out)), 180000);
  const mp4 = join(DIR, out);
  log('exported', out);

  // 2. The canvas, one look at a time (the look project has no shots: its canvas draws exactly the layout it's given).
  const drawLook = async (look, t) => {
    await api(`/api/projects/${LOOK}/layout`, { layout: look });
    await page.goto(`${BASE}/?t=${Date.now()}#/p/${encodeURIComponent(LOOK)}`);
    await page.waitForSelector('[data-tab=canvas]', { timeout: 30000 });
    await page.click('[data-tab=canvas]');
    await ready(LOOK);
    await page.evaluate(async (tt) => {
      const vids = [...document.querySelectorAll('video.hidden-media')];
      for (const v of vids) v.pause();
      await Promise.all(vids.map((v) => new Promise((done) => { v.addEventListener('seeked', done, { once: true }); v.currentTime = tt + 1 / 60; })));
      for (let i = 0; i < 4; i++) await new Promise((r) => requestAnimationFrame(r));
    }, t);
    return async (pts) => page.evaluate((list) => { const g = document.querySelector('#stage').getContext('2d'); return list.map(([x, y]) => [...g.getImageData(x, y, 1, 1).data].slice(0, 3)); }, pts);
  };
  const exportAt = (n, pts) => pts.map(([x, y]) => { const b = execFileSync('ffmpeg', ['-v', 'error', '-i', mp4, '-vf', `select='eq(n,${n})',format=rgb24,crop=1:1:${x}:${y}`, '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-']); return [b[0], b[1], b[2]]; });
  // Points worth comparing: inside every card of the look(s) (the camera's bars, the screen's middle, the top of the
  // screen where the red band is unless the shot zooms in) and some background.
  const pointsFor = (looks) => {
    const pts = [];
    for (const l of looks) for (const ly of L.compose(l, dims).layers) {
      const { x, y, w, h } = ly.box;
      if (ly.role === 'cam') pts.push([x + Math.round(w * 0.31), y + Math.round(h * 0.4)], [x + Math.round(w * 0.6), y + Math.round(h * 0.4)]);
      else pts.push([x + Math.round(w * 0.5), y + Math.round(h * 0.5)], [x + Math.round(w * 0.3), y + Math.round(h * 0.035)], [x + Math.round(w * 0.7), y + Math.round(h * 0.97)]);
    }
    return pts.filter((p, i, a) => a.findIndex((q) => q[0] === p[0] && q[1] === p[1]) === i);
  };
  const base = L.normalize(P.layout, P.type);
  // The canvas plays H.264 playback copies through the browser's decoder, which lands saturated colours up to ~26 levels
  // off ffmpeg's (SMPTE green 161 vs 187, the same in a plain export): a wrong look is 100+ levels off at these points.
  // (The smoke test checks the crossfade's weights on the MP4 itself, to ±6.)
  const TOL = 40;
  for (const t of [2.0, 6.0, 7.9, 8.1, 11.0]) {
    const n = Math.round(t * 30), tt = n / 30;
    const tr = L.transitionAt(tt, base, kept, { duration: SECS });
    const looks = tr ? [tr.from, tr.to] : [L.lookAt(tt, base, kept)];
    const pts = pointsFor(looks);
    const shots = [];
    for (const l of looks) shots.push(await (await drawLook(l, tt))(pts));
    const exp = exportAt(n, pts);
    const want = tr ? shots[0].map((c, i) => c.map((v, j) => Math.round(v * (1 - tr.p) + shots[1][i][j] * tr.p))) : shots[0];
    let worst = 0;
    pts.forEach((_, i) => { worst = Math.max(worst, ...want[i].map((v, j) => Math.abs(v - exp[i][j]))); });
    const ok = worst <= TOL;
    if (!ok) { failures++; log(`FAIL at ${tt.toFixed(3)} s: worst ${worst}`, JSON.stringify({ pts, want, exp })); }
    if (process.env.VERBOSE) log(tt.toFixed(3), JSON.stringify(pts.map((p, i) => [p, want[i], exp[i]])));
    results.push(`${tt.toFixed(2)} s ${tr ? `crossfade p ${tr.p.toFixed(2)} (${tr.from.preset} → ${tr.to.preset})` : looks[0].preset}: ${pts.length} points, worst ${worst}`);
  }
  // The proposal (Camera at 10 s) isn't in the MP4: 11 s above is PiP. The red band is gone in the zoomed shot (6 s).
} finally {
  await browser.close();
  await api(`/api/projects/${LOOK}/layout`, { layout: baseLayout }).catch(() => {});
}
for (const r of results) log(r);
if (failures) { log(`${failures} failed`); process.exit(1); }
console.log(`preview = export: ${results.join(' · ')}`);
