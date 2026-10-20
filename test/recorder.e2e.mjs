// End-to-end test of Video Octopus's recorder, through the real UI, in headless Chromium with fake devices
// (Chromium's fake camera and mic; the screen is ?fakeScreen=1's moving test picture, or with REAL_PICKER=1
// Chromium's own fake screen through getDisplayMedia). Nothing real is ever opened: the fake-device flags
// replace every camera, mic and screen.
//
//   STUDIO_URL=http://127.0.0.1:4821 STUDIO_PROJECT=<project id> node test/recorder.e2e.mjs
//
// Env: STUDIO_URL (default http://127.0.0.1:4821); STUDIO_PROJECT (default: a new project "studio-test-e2e-rec");
// PLAYWRIGHT_PATH (default 'playwright'); FFPROBE (default 'ffprobe'); STUDIO_DIR (the project folder, if the
// test can't read it at the path Video Octopus reports); CASES (default new,cam,screen,mic,layer,block; also: recover);
// SECONDS (length of each take, default 3.5); HEADED=1 to watch.
//   new     Home → New project → "Record a new take now" → the record panel → screen + camera + mic → Stop: the take
//           is the new project's canvas take, its playback copies are made, the canvas plays them and Clean up is next
//   cam, screen, mic   a camera / screen + camera / mic-only take in place of the project's take
//   layer   a camera take added as a layer;  block   a camera take recorded into a block (its own file)
//   recover a take whose page closed mid-take, finished from a fresh page
// Exits 0 only when every take's files land where they should, with the right streams.
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_PATH || 'playwright');
const BASE = (process.env.STUDIO_URL || 'http://127.0.0.1:4821').replace(/\/$/, '');

// The first-time help (the steps' "How a video gets made here") opens over a fresh studio's first project page and
// would catch the clicks below: say it's been seen, the way pressing Got it does.
await fetch(`${BASE}/api/app/settings`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Studio': '1' }, body: JSON.stringify({ section: 'help', values: { stepsIntro: 'dismissed' } }) }).catch(() => {});
const FFPROBE = process.env.FFPROBE || 'ffprobe';
const CASES = (process.env.CASES || 'new,cam,screen,mic,layer,block').split(',').map((s) => s.trim()).filter(Boolean);
const SECS = Number(process.env.SECONDS) || 3.5;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log('[recorder e2e]', ...a);

async function api(path, data) {
  const r = await fetch(BASE + path, data === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Studio': '1' }, body: JSON.stringify(data) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`${path}: ${j.error || r.status}`);
  return j;
}
async function until(what, fn, ms = 90000, every = 400) {
  const t0 = Date.now();
  for (;;) {
    const v = await fn().catch(() => null);
    if (v) return v;
    if (Date.now() - t0 > ms) throw new Error(`Timed out waiting for ${what}`);
    await sleep(every);
  }
}

// ---- ffprobe ----
const tmp = mkdtempSync(join(tmpdir(), 'studio-rec-e2e-'));
async function localFile(P, f) {
  const dir = process.env.STUDIO_DIR || P.path;
  const p = join(dir, 'source', f);
  if (existsSync(p)) return p;
  const r = await fetch(`${BASE}/api/projects/${encodeURIComponent(P.id)}/media?f=${encodeURIComponent(`source/${f}`)}`);
  if (!r.ok) throw new Error(`Couldn't download source/${f} (${r.status})`);
  const out = join(tmp, f);
  writeFileSync(out, Buffer.from(await r.arrayBuffer()));
  return out;
}
function probe(p) {
  const j = JSON.parse(execFileSync(FFPROBE, ['-v', 'error', '-show_entries',
    'stream=codec_type,codec_name,r_frame_rate,avg_frame_rate,sample_rate,sample_fmt,bits_per_sample,width,height:format=duration,format_name', '-of', 'json', p]));
  const v = j.streams.find((s) => s.codec_type === 'video'), a = j.streams.find((s) => s.codec_type === 'audio');
  let frameDurations = null;
  if (v) {
    const out = String(execFileSync(FFPROBE, ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'packet=duration', '-of', 'csv=p=0', p]));
    frameDurations = [...new Set(out.split('\n').map((x) => x.trim()).filter(Boolean))];
  }
  return { duration: Number(j.format.duration), format: j.format.format_name, v, a, frameDurations };
}

const failures = [];
const check = (ok, text) => { (ok ? log : (t) => { failures.push(t); console.error('[recorder e2e] FAIL', t); })(`${ok ? 'ok  ' : ''}${text}`); };

async function checkFiles(P, files, kind) {
  const info = {};
  for (const f of files) info[f] = probe(await localFile(P, f));
  for (const [f, x] of Object.entries(info)) {
    if (/\.wav$/.test(f)) {
      check(x.a?.codec_name === 'pcm_s24le' || x.a?.codec_name === 'pcm_f32le', `${f}: PCM audio (${x.a?.codec_name})`);
      check(x.a?.sample_rate === '48000', `${f}: 48 kHz (${x.a?.sample_rate})`);
      check(!x.v, `${f}: no picture`);
    } else {
      check(x.v?.codec_name === 'h264', `${f}: H.264 video (${x.v?.codec_name} ${x.v?.width}x${x.v?.height})`);
      check(x.a?.codec_name === 'aac', `${f}: AAC audio (${x.a?.codec_name} ${x.a?.sample_rate} Hz)`);
      check(x.v?.r_frame_rate === '30/1' && x.v?.avg_frame_rate === '30/1' && x.frameDurations?.length === 1, `${f}: constant 30 fps (r ${x.v?.r_frame_rate}, avg ${x.v?.avg_frame_rate}, frame durations ${x.frameDurations?.join('/')})`);
    }
    check(x.duration > SECS - 1.5 && x.duration < SECS + 2, `${f}: ${x.duration.toFixed(3)} s long`);
  }
  if (kind === 'screen') {
    const [a, b] = files.map((f) => info[f].duration);
    check(Math.abs(a - b) <= 0.1, `screen and camera within 0.1 s (${a.toFixed(3)} vs ${b.toFixed(3)})`);
  }
  return info;
}

// ---- the UI ----
// A page with fake devices whose errors and toasts ("Couldn't save the take: …") go to this test's log.
async function newPage(browser) {
  const ctx = await browser.newContext({ permissions: ['camera', 'microphone'], viewport: { width: 1440, height: 900 } });
  await ctx.addInitScript(() => addEventListener('DOMContentLoaded', () => {
    const t = document.getElementById('toast');
    if (t) new MutationObserver(() => { if (!t.hidden && t.textContent) console.log(`[toast] ${t.textContent}`); }).observe(t, { childList: true, characterData: true, subtree: true, attributes: true });
  }));
  const page = await ctx.newPage();
  page.on('pageerror', (e) => console.error('[page error]', e.message));
  page.on('console', (m) => { if (m.type() === 'error') console.error('[page console]', m.text()); else if (m.text().startsWith('[toast]')) log(m.text()); });
  return { ctx, page };
}
async function openProject(browser, id) {
  const { ctx, page } = await newPage(browser);
  await page.goto(`${BASE}/${process.env.REAL_PICKER ? '' : '?fakeScreen=1'}#/p/${encodeURIComponent(id)}`);
  await page.waitForSelector('#recBtn:not([disabled])');
  await page.waitForFunction(() => document.querySelector('#recText')?.textContent === 'Record');
  return { ctx, page };
}

// kind: 'screen' (screen + camera + mic), 'cam' (camera + mic), 'mic' (mic only). target 'replace' | 'layer'.
// opened: the record panel is up already (New project → Record a new take now, a block's Record it).
async function recordTake(page, kind, target, { secs = SECS, keepOpen = false, opened = false } = {}) {
  if (!opened) await page.click('#recBtn');
  await page.waitForSelector('.rec-page #rStart');
  await page.waitForFunction(() => document.querySelector('#rCamera')?.options.length > 1 && document.querySelector('#rMic')?.options.length > 1, null, { timeout: 20000 });
  if (kind === 'screen') { await page.click('#scrPick'); await page.waitForFunction(() => document.querySelector('#pvScreen')?.srcObject); }
  else if (await page.isVisible('#scrNone')) await page.click('#scrNone');
  await page.selectOption('#rCamera', kind === 'mic' ? 'none' : { index: 1 });
  await page.selectOption('#rMic', { index: 1 });
  if (kind !== 'mic') await page.waitForFunction(() => document.querySelector('#pvCam')?.srcObject);
  await page.waitForFunction(() => document.querySelector('#rPerm')?.hidden !== false && !document.querySelector('#rStart').disabled);
  await page.click('#rCount [data-c="0"]');
  if (await page.$('#rTarget')) await page.click(`#rTarget [data-t="${target}"]`);
  const label = await page.textContent('#rStartL');
  log(`recording "${label}" (${target}) for ${secs} s`);
  await page.click('#rStart');
  await page.waitForFunction(() => /^Stop/.test(document.querySelector('#recText')?.textContent || ''), null, { timeout: 15000 });
  await sleep(secs * 1000);
  if (keepOpen) return label;
  await page.click('#recBtn');
  await page.waitForFunction(() => document.querySelector('#recText')?.textContent === 'Record', null, { timeout: 120000 });
  return label;
}

// Home → New project → Record a new take now: the panel opens on the new project; the take becomes its canvas take,
// the playback copies are made, the canvas plays them, and Clean up is the next step.
async function newProjectCase(browser) {
  const { ctx, page } = await newPage(browser);
  try {
    await page.goto(`${BASE}/${process.env.REAL_PICKER ? '' : '?fakeScreen=1'}#/`);
    await page.click('#newBtn');
    await page.waitForSelector('.dialog.np #pname');
    const name = `studio-test-e2e-new ${Date.now() % 100000}`;
    await page.fill('#pname', name);
    if (await page.$('.dialog.np .type[data-k="tutorial"]')) await page.click('.dialog.np .type[data-k="tutorial"]');
    await page.check('input[name=ptake][value=record]');
    check((await page.textContent('#create')) === 'Create and record', 'new: the dialog says "Create and record"');
    await page.click('#create');
    await page.waitForFunction(() => /^#\/p\//.test(location.hash), null, { timeout: 15000 });
    const pid = decodeURIComponent((await page.evaluate(() => location.hash)).replace(/^#\/p\//, '').split(/[/?]/)[0]);
    log(`new: made ${pid}; the record panel should open by itself`);
    await recordTake(page, 'screen', 'replace', { opened: true });
    const P = await until('the take in the new project', async () => { const p = await api(`/api/projects/${encodeURIComponent(pid)}`); return p.roles.take.length === 2 ? p : null; });
    const files = [...P.roles.take].sort();
    const stamp = files[0].replace(/_(screen|webcam)\..+$/, '');
    check(JSON.stringify(files) === JSON.stringify([`${stamp}_screen.mp4`, `${stamp}_webcam.mp4`]), `new: the take is the project's canvas take (${files.join(', ')})`);
    check(P.canvas?.screen === `${stamp}_screen.mp4` && P.canvas?.cam === `${stamp}_webcam.mp4`, `new: the canvas uses it (screen ${P.canvas?.screen}, camera ${P.canvas?.cam})`);
    await checkFiles(P, files, 'screen');
    const Q = await until('the playback copies', async () => { const p = await api(`/api/projects/${encodeURIComponent(pid)}`); return files.every((f) => p.proxies[f]) ? p : null; }, 120000, 1000).catch(() => null);
    check(Boolean(Q), `new: playback copies ${Q ? files.map((f) => Q.proxies[f]).join(', ') : 'missing'}`);
    if (Q) {
      // The canvas loads each playback copy into its player and shows a picture.
      const shown = await page.waitForFunction((want) => {
        const vids = [...document.querySelectorAll('video.hidden-media')];
        const ok = want.every((p) => vids.some((v) => decodeURIComponent(v.src).includes(p) && v.readyState >= 2 && v.videoWidth > 0));
        return ok && document.querySelector('#stage') ? vids.filter((v) => v.videoWidth > 0).map((v) => `${v.videoWidth}x${v.videoHeight}`) : null;
      }, files.map((f) => Q.proxies[f]), { timeout: 60000 }).then((h) => h.jsonValue()).catch(() => null);
      check(Boolean(shown), `new: the canvas plays the take (${shown ? shown.join(', ') : 'no picture'})`);
      check(Q.pipeline?.next === 'prepare', `new: Clean up is the next step (${Q.pipeline?.next})`);
      const dock = await page.waitForSelector('.dk-run[data-a="run"]', { timeout: 15000 }).then((b) => b.getAttribute('aria-label')).catch(() => null);
      check(/Clean up/.test(dock || ''), `new: the dock offers ${dock || 'nothing'}`);
    }
  } finally { await ctx.close(); }
}

// A block that waits for a recording (as "+ Add block → Record new" makes it): its menu's "Record it" opens the panel
// for that block, and the take becomes the block's own file; the canvas take stays.
async function blockCase(browser, id, before) {
  const r = await api(`/api/projects/${encodeURIComponent(id)}/blocks`, { op: 'insert', type: 'sponsor', label: 'Sponsor read', source: { pending: 'record' }, where: { before: null } });
  const blk = (r.view?.items || []).find((x) => x.label === 'Sponsor read' && x.kind === 'pending');
  if (!blk) throw new Error('block: the pending block was not made');
  const { ctx, page } = await openProject(browser, id);
  try {
    await page.click(`.bk[data-id="${blk.id}"] .bk-dots`);
    await page.click('.bk-menu [data-a="record"]');
    await page.waitForSelector('.rec-page #rStart');
    check(/Sponsor read/.test(await page.textContent('#rpTitle')), `block: the panel records the block (${await page.textContent('#rpTitle')})`);
    await recordTake(page, 'cam', 'replace', { opened: true });
    const v = await until('the block\'s file', async () => { const b = await api(`/api/projects/${encodeURIComponent(id)}/blocks`); const x = b.items.find((y) => y.id === blk.id); return x?.source?.file ? x : null; });
    check(/_webcam\.mp4$/.test(v.source.file), `block: the take is the block's file (${v.source.file})`);
    const P = await api(`/api/projects/${encodeURIComponent(id)}`);
    check(JSON.stringify(P.roles.take) === JSON.stringify(before.roles.take), 'block: the canvas take stayed');
    const x = probe(await localFile(P, v.source.file.replace(/^source\//, '')));
    check(x.v?.codec_name === 'h264' && x.a?.codec_name === 'aac' && x.v?.avg_frame_rate === '30/1', `block: ${v.source.file} is H.264 + AAC at 30 fps (${x.duration.toFixed(2)} s)`);
  } finally { await ctx.close(); }
}

async function run() {
  let id = process.env.STUDIO_PROJECT;
  if (!id) {
    id = (await api('/api/projects', { name: 'studio-test-e2e-rec', type: 'tutorial' })).id;
    log(`made the test project ${id}`);
  }
  const browser = await chromium.launch({
    headless: !process.env.HEADED,
    args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', '--autoplay-policy=no-user-gesture-required'],
  });
  try {
    const { ctx, page } = await openProject(browser, id);
    for (const c of CASES) {
      const before = await api(`/api/projects/${encodeURIComponent(id)}`);
      const had = new Set(before.roles.files);
      if (c === 'new') { await newProjectCase(browser); continue; }
      if (c === 'block') { await blockCase(browser, id, before); continue; }
      if (c === 'recover') {
        // Close the page mid-take (no unload handlers), then finish the unsaved take from a fresh page.
        const second = await openProject(browser, id);
        await recordTake(second.page, 'cam', 'replace', { keepOpen: true });
        await second.page.close({ runBeforeUnload: false });
        await second.ctx.close();
        log('closed the page mid-take; waiting for Video Octopus to see the take as unsaved');
        await sleep(6500);
        const third = await openProject(browser, id);
        await third.page.waitForSelector('.rec-recover [data-a=finish]', { timeout: 15000 });
        await third.page.click('.rec-recover [data-a=finish]');
        const P = await until('the recovered take', async () => { const p = await api(`/api/projects/${encodeURIComponent(id)}`); return p.roles.files.some((f) => !had.has(f)) ? p : null; });
        const files = P.roles.files.filter((f) => !had.has(f));
        check(files.length === 1 && /_webcam\.mp4$/.test(files[0]), `recovered take: ${files.join(', ')}`);
        const x = probe(await localFile(P, files[0]));
        check(x.v?.codec_name === 'h264' && x.a?.codec_name === 'aac' && x.v?.avg_frame_rate === '30/1', `recovered ${files[0]}: H.264 + AAC, 30 fps, ${x.duration.toFixed(2)} s`);
        check(x.duration > SECS - 2.5, `recovered take kept what was recorded before the page closed (${x.duration.toFixed(2)} s of ~${SECS} s)`);
        await third.ctx.close();
        continue;
      }
      const kind = c === 'layer' ? 'cam' : c;
      const target = c === 'layer' ? 'layer' : 'replace';
      await recordTake(page, kind, target);
      const P = await until('the take in the project', async () => {
        const p = await api(`/api/projects/${encodeURIComponent(id)}`);
        if (!p.roles.files.some((f) => !had.has(f))) return null;
        return target === 'layer' || p.roles.take.every((f) => !had.has(f)) ? p : null;
      }).catch(async (e) => {
        // What did arrive, for the log: new files, the canvas take, layers, the newest takes and unsaved ones.
        const p = await api(`/api/projects/${encodeURIComponent(id)}`).catch(() => null);
        const takes = await api('/api/takes').catch(() => []), open = await api('/api/rec-unfinished').catch(() => null);
        log(`${c}: new files ${p?.roles.files.filter((f) => !had.has(f)).join(', ') || 'none'} · take ${p?.roles.take.join(', ')} · layers ${(p?.layout.layers || []).map((x) => x.file).join(', ') || 'none'} · newest takes ${takes.slice(0, 2).map((t) => `${t.id} [${t.files.join(', ')}]`).join('; ')} · unsaved ${JSON.stringify(open?.takes || [])}`);
        throw e;
      });
      const files = P.roles.files.filter((f) => !had.has(f)).sort();
      const stamp = files[0].replace(/_(screen|webcam|audio)\..+$/, '');
      const want = kind === 'screen' ? [`${stamp}_screen.mp4`, `${stamp}_webcam.mp4`] : kind === 'cam' ? [`${stamp}_webcam.mp4`] : [`${stamp}_audio.wav`];
      check(JSON.stringify(files) === JSON.stringify(want), `${c}: take files ${files.join(', ')}`);
      if (target === 'replace') {
        check(JSON.stringify([...P.roles.take].sort()) === JSON.stringify(want), `${c}: the take is the canvas take (${P.roles.take.join(', ')})`);
        if (kind === 'mic') check(P.roles.audioOnly, `${c}: the mic-only take is audio only on the canvas`);
      } else {
        check(P.layout.layers.some((x) => x.file === want[0]), `layer: ${want[0]} is a layer (${P.layout.layers.map((x) => x.file).join(', ')})`);
        check(JSON.stringify(P.roles.take) === JSON.stringify(before.roles.take), 'layer: the canvas take stayed');
      }
      await checkFiles(P, files, kind);
      // Playback copies for the videos (a WAV plays as it is).
      if (kind !== 'mic') {
        const Q = await until('the playback copies', async () => { const p = await api(`/api/projects/${encodeURIComponent(id)}`); return want.every((f) => p.proxies[f]) ? p : null; }, 120000, 1000).catch(() => null);
        check(Boolean(Q), `${c}: playback copies ${Q ? want.map((f) => Q.proxies[f]).join(', ') : 'missing'}`);
      }
    }
    await ctx.close();
  } finally {
    await browser.close();
    rmSync(tmp, { recursive: true, force: true });
  }
}

run().then(() => {
  if (failures.length) { console.error(`[recorder e2e] ${failures.length} check(s) failed`); process.exit(1); }
  log('all checks passed');
  process.exit(0);
}, (e) => { console.error('[recorder e2e] error:', e.message); process.exit(1); });
