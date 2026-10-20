// End-to-end test of Claude's proposals, zooms and the slide / zoom transitions, through the real page in headless
// Chromium (E2E run 2: N1, m-n10). It opens the zooms fixture project the smoke test made and exported
// (test/smoke.mjs "zooms export": gradients on the screen and the camera, kept zooms, a slide and a zoom transition,
// Claude's proposed shot and zoom) and checks that:
//   - the canvas draws what the MP4 has, frame for frame: inside a screen zoom's ramp, a camera punch-in, a slide, the
//     zoom transition, and where Claude's proposals are (the preview leaves them out, like the export);
//   - a proposal shows on the picture only on Preview, and Keep it / No thanks (on the lanes and the picture's tag) write
//     the files; the kept zoom then plays in the preview;
//   - Z + a box on the picture adds a zoom into that area, the zoom inspector changes it, and the transition popover
//     offers Slide (← → ↑) and Zoom and shows the real current one.
//
//   STUDIO_URL=http://127.0.0.1:4915 ZX_OUT=renders/zooms-export-fixture_pip_v1.mp4 node test/zooms.e2e.mjs
//
// Env: STUDIO_URL; ZX_OUT (the export, relative to the project); PLAYWRIGHT_PATH; SHOTS_DIR (screenshots); HEADED=1.
// Nothing is recorded and no chat or step is sent (those requests are aborted).
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_PATH || 'playwright');
const BASE = (process.env.STUDIO_URL || 'http://127.0.0.1:4915').replace(/\/$/, '');
const ID = 'zooms-export-fixture';
const L = await import(new URL('../web/layout.js', import.meta.url).href);
const X = await import(new URL('../web/exportshots.js', import.meta.url).href);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log('[zooms e2e]', ...a);
async function api(path, data) {
  const r = await fetch(BASE + path, data === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Studio': '1' }, body: JSON.stringify(data) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`${path}: ${j.error || r.status}`);
  return j;
}
async function until(what, fn, ms = 20000, every = 200) {
  const t0 = Date.now();
  for (;;) {
    const v = await fn().catch(() => null);
    if (v) return v;
    if (Date.now() - t0 > ms) throw new Error(`Timed out waiting for ${what}`);
    await sleep(every);
  }
}
await api('/api/app/settings', { section: 'help', values: { stepsIntro: 'dismissed' } }).catch(() => {});
const status = await api('/api/status');
const DIR = join(status.studio, status.projectsDir || 'projects', ID);
const read = (f) => JSON.parse(readFileSync(join(DIR, f), 'utf8'));
const shotsBefore = readFileSync(join(DIR, 'work/shots.json'), 'utf8'), zoomsBefore = readFileSync(join(DIR, 'work/zooms.json'), 'utf8');
const MP4 = join(DIR, process.env.ZX_OUT || 'renders/zooms-export-fixture_pip_v1.mp4');
const SHOTS = process.env.SHOTS_DIR || null;
if (SHOTS) mkdirSync(SHOTS, { recursive: true });

// The canvas plays the playback copies: make them, and wait until both are there.
await api(`/api/projects/${ID}/proxies`, {});
let n0 = 0;
const P = await until('the playback copies', async () => {
  if (++n0 % 30 === 0) await api(`/api/projects/${ID}/proxies`, {}).catch(() => {});
  const v = await api(`/api/projects/${ID}`);
  return Object.values(v.proxies || {}).filter(Boolean).length >= 2 && v.export?.dims?.cam ? v : null;
}, 180000, 300);
const base = L.normalize(P.layout, P.type), dims = P.export.dims, kept = X.keptShots(P.shots);
const W = 1920, H = 1080;
const exportAt = (n, pts) => { const b = execFileSync('ffmpeg', ['-v', 'error', '-i', MP4, '-vf', `select='eq(n,${n})',format=rgb24`, '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'], { maxBuffer: 64e6 }); return pts.map(([x, y]) => { const o = (y * W + x) * 3; return [b[o], b[o + 1], b[o + 2]]; }); };
// Points in every card of the looks at that moment (the screen away from the PiP, the camera inside its box) and on a grid
// over the whole frame (for the transitions).
function pointsAt(n) {
  const t = n / 30, tr = L.transitionAt(t, base, kept, { duration: 6 }), pts = [];
  if (tr) {
    // (not on a slide's seam: a hair of time moves it)
    const seam = tr.type === 'slide' ? L.slideOffsets(tr.dir, tr.p, W, H).to[0] : -1e9;
    for (let i = 1; i < 8; i++) for (let j = 1; j < 5; j++) { const x = Math.round((i / 8) * W); if (Math.abs(x - seam) > 12) pts.push([x, Math.round((j / 5) * H)]); }
    return pts;
  }
  const sc = L.compose(L.lookAt(t, base, kept), dims), cam = sc.layers.find((x) => x.ref === 'cam');
  for (const ly of sc.layers) for (let i = 1; i < 6; i++) for (let j = 1; j < 6; j++) {
    const x = Math.round(ly.box.x + (0.15 + 0.7 * (i / 6)) * ly.box.w), y = Math.round(ly.box.y + (0.15 + 0.7 * (j / 6)) * ly.box.h);
    if (ly.ref === 'screen' && cam && x > cam.box.x - 6 && y > cam.box.y - 6 && x < cam.box.x + cam.box.w + 6 && y < cam.box.y + cam.box.h + 6) continue;
    pts.push([x, y]);
  }
  return pts;
}

const browser = await chromium.launch({ headless: !process.env.HEADED, args: ['--autoplay-policy=no-user-gesture-required'] });
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
await page.route('**/*', (route) => {
  const r = route.request();
  if (r.method() === 'POST' && /\/(chat|step|send|ask)(\?|$)/.test(r.url())) return route.abort();
  return route.continue();
});
const pageErrors = [];
page.on('pageerror', (e) => { pageErrors.push(e.message); log('page error:', e.message); });
const shot = async (name) => { if (SHOTS) await page.screenshot({ path: join(SHOTS, `${name}.png`) }); };
// Seeked is not shown: under load a video's new frame can come a few paints later, and a read before it gets the frame
// before. So wait for each video to present its frame (requestVideoFrameCallback, at most 1 s), then for the canvas.
const seekTo = (t) => page.evaluate(async (tt) => {
  const vids = [...document.querySelectorAll('video.hidden-media')];
  for (const v of vids) v.pause();
  await Promise.all(vids.map((v) => new Promise((done) => {
    let left = 2;
    const one = () => { if (--left === 0) done(); };
    v.addEventListener('seeked', one, { once: true });
    if (v.requestVideoFrameCallback) { v.requestVideoFrameCallback(one); setTimeout(() => { if (left > 0) { left = 1; one(); } }, 1000); } else left = 1;
    v.currentTime = tt;
  })));
  for (let i = 0; i < 4; i++) await new Promise((r) => requestAnimationFrame(r));
}, t);
const canvasAt = (pts) => page.evaluate((list) => { const g = document.querySelector('#stage').getContext('2d'); return list.map(([x, y]) => [...g.getImageData(x, y, 1, 1).data].slice(0, 3)); }, pts);
const diff = (a, b) => { let sum = 0, worst = 0; a.forEach((c, i) => c.forEach((v, q) => { const d = Math.abs(v - b[i][q]); sum += d; worst = Math.max(worst, d); })); return { mean: sum / (a.length * 3), worst }; };

const failed = [];
const results = [];
const fail = (msg) => { failed.push(msg); log('FAIL', msg); };
try {
  await page.goto(`${BASE}/#/p/${encodeURIComponent(ID)}`);
  await page.waitForSelector('[data-tab=canvas]', { timeout: 30000 });
  await page.click('[data-tab=canvas]');
  await page.waitForFunction(() => document.querySelector('#stage') && [...document.querySelectorAll('video.hidden-media')].length >= 2 && [...document.querySelectorAll('video.hidden-media')].every((v) => v.readyState >= 2), null, { timeout: 90000 });

  // 1. The preview = the MP4, frame for frame (the browser decodes the playback copies: a few levels off ffmpeg's).
  const frames = { 27: 'screen zoom easing in', 50: 'camera punch-in', 88: 'slide', 133: 'zoom transition (push in)', 140: 'zoom transition (fade)', 162: 'Claude’s proposed zoom: left out', 170: 'Claude’s proposed shot: left out' };
  for (const [n, what] of Object.entries(frames).map(([k, v]) => [Number(k), v])) {
    const pts = pointsAt(n);
    await seekTo(n / 30 + 0.0005); // (just inside frame n: a slide moves ~4 px per ms)
    const want = exportAt(n, pts);
    let d = diff(await canvasAt(pts), want);
    // Once more from a fresh seek before calling it wrong: a busy machine can still paint late; a wrong zoom, offset or
    // look is wrong both times.
    if (d.mean > 12 || d.worst > 40) { await seekTo(0); await seekTo(n / 30 + 0.0005); d = diff(await canvasAt(pts), want); }
    // (the browser decodes the playback copies a few levels off ffmpeg's, ~6 on average here; a wrong zoom, offset or
    // look is 30+ on average)
    if (d.mean > 12 || d.worst > 40) fail(`${n} (${what}): preview vs export mean ${d.mean.toFixed(1)}, worst ${d.worst}`);
    results.push(`${what} (frame ${n}) mean ${d.mean.toFixed(1)}, worst ${d.worst}`);
    if (n === 88) {
      await shot('z1-slide-preview');
      if (SHOTS) execFileSync('ffmpeg', ['-v', 'error', '-y', '-i', MP4, '-vf', `select='eq(n,${n})'`, '-frames:v', '1', join(SHOTS, 'z1-slide-export.png')]);
    }
  }

  // 2. A proposal on the picture: the tag, Preview shows it, the files only change on Keep it / No thanks.
  await seekTo(5.4);
  await page.waitForSelector('#propTag:not([hidden])', { timeout: 5000 });
  const tagText = await page.textContent('#propTag .pt-t');
  if (!/Claude proposed · Zoom 3/.test(tagText)) fail(`the tag: ${tagText}`);
  const pts = pointsAt(162), plain = await canvasAt(pts);
  await page.click('#propTag [data-p=preview]');
  await sleep(300);
  const peek = await canvasAt(pts);
  if (diff(plain, peek).mean < 12) fail(`Preview didn't show the proposed zoom (${diff(plain, peek).mean.toFixed(1)})`);
  if (read('work/zooms.json').items.find((z) => z.id === 'z3')?.status !== 'proposed') fail('Preview changed the file');
  await shot('z2-proposal-preview');
  await page.click('#propTag [data-p=preview]'); // Hide: back to what the export renders
  await sleep(300);
  if (diff(plain, await canvasAt(pts)).mean > 3) fail('Hide did not put the picture back');
  // Keep it on the Zooms lane: z3 is the creator's now, and plays in the preview without Preview.
  const z3keep = page.locator('.prop-acts[aria-label*="Zoom 3"] .pa-keep');
  await z3keep.click();
  await until('z3 kept', async () => !read('work/zooms.json').items.find((z) => z.id === 'z3')?.status);
  await page.mouse.click(5, 5);
  await seekTo(5.4);
  if (diff(plain, await canvasAt(pts)).mean < 12) fail('the kept zoom does not play in the preview');
  results.push(`zoom 3: tag "${tagText.slice(0, 40)}…", Preview / Hide, Keep it on the lane → it plays`);
  // No thanks on the picture's tag for Claude's proposed shot (5.2 s): it's gone from shots.json.
  await seekTo(5.9);
  await page.waitForFunction(() => /Shot 4/.test(document.querySelector('#propTag .pt-t')?.textContent || ''), null, { timeout: 5000 });
  await shot('z3-proposed-shot-tag');
  await page.click('#propTag [data-p=reject]');
  await until('c1 turned down', async () => !read('work/shots.json').shots.some((s) => s.id === 'c1'));
  results.push('shot 4: No thanks on the tag removed it');

  // 3. Z + a box on the screen at 0:00.2: a zoom into that area, from the playhead, 3 s.
  await seekTo(0.2);
  await page.keyboard.press('z');
  const st = await page.locator('#stage').boundingBox(), sx = st.width / W;
  const box = { x: 300, y: 200, w: 640 };
  await page.mouse.move(st.x + box.x * sx, st.y + box.y * sx);
  await page.mouse.down();
  await page.mouse.move(st.x + (box.x + box.w / 2) * sx, st.y + (box.y + 150) * sx, { steps: 4 });
  await page.mouse.move(st.x + (box.x + box.w) * sx, st.y + (box.y + box.w * 9 / 16) * sx, { steps: 4 });
  await shot('z4-z-drag');
  await page.mouse.up();
  const made = await until('the new zoom', async () => read('work/zooms.json').items.find((z) => !z.by && z.a === 0.2));
  const fr = (v, w) => Math.abs(v - w) < 0.02;
  if (made.target !== 'screen' || !fr(made.box.x, box.x / W) || !fr(made.box.y, box.y / H) || !fr(made.box.w, box.w / W) || made.d !== 3.2) fail(`Z made ${JSON.stringify(made)}`);
  await page.waitForSelector('#zoomSec:not([hidden])', { timeout: 5000 });
  await page.click('#zmSpeed [data-v=snap]');
  await until('snap', async () => read('work/zooms.json').items.find((z) => z.id === made.id)?.speed === 'snap');
  if (!(await page.isDisabled('#zmIn'))) fail('ease in is editable on a snap zoom');
  await page.fill('#zmD', '2.5'); await page.press('#zmD', 'Enter');
  await until('trimmed', async () => read('work/zooms.json').items.find((z) => z.id === made.id)?.d === 2.5);
  await shot('z5-zoom-inspector');
  results.push(`Z: box ${JSON.stringify(made.box)} at 0:00.2–0:03.2, Snap and Ends 2.5 in the inspector`);

  // 4. The transition popover: the real current one (Slide ←), Slide → and Zoom picked by hand.
  await page.locator('.sh-key.brk').first().focus();
  await page.keyboard.press('Enter');
  await page.waitForSelector('.shp');
  const on = await page.textContent('.shp-t.on > span:not(.trd)'), dirOn = await page.getAttribute('.shp-dir .on', 'data-d');
  if (on !== 'Slide' || dirOn !== 'left') fail(`the popover shows ${on} ${dirOn}`);
  await page.click('.shp-dir [data-d=right]');
  await until('slide right', async () => read('work/shots.json').shots.find((s) => s.id === 's2')?.in?.dir === 'right');
  await shot('z6-transition-popover');
  await page.click('.shp-t[data-t=zoom]');
  await until('zoom', async () => read('work/shots.json').shots.find((s) => s.id === 's2')?.in?.type === 'zoom');
  if (await page.isVisible('.shp-dir')) fail('the direction stays for a zoom');
  results.push('popover: Slide ← shown, Slide → and Zoom picked');
  if (pageErrors.length) fail(`page errors: ${pageErrors.join(' | ')}`);
} catch (e) {
  fail(e.message);
  await shot('z-error').catch(() => {});
} finally {
  await browser.close();
  writeFileSync(join(DIR, 'work/shots.json'), shotsBefore);
  writeFileSync(join(DIR, 'work/zooms.json'), zoomsBefore);
}
for (const r of results) log(r);
if (failed.length) { log(`${failed.length} failed: ${failed.join(' | ')}`); process.exit(1); }
console.log(`preview = export with zooms and transitions, proposals out until kept: ${results.join(' · ')}`);
