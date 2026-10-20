// End-to-end test of the Cut tab's Keep / Cut list with the built-in Cut Editor, through the page in headless Chromium,
// on a made-up take (tone bursts where the words are):
//   1. The count: a clipped join that join-check's fix already resolved (it's in work/edl_fixed.json) isn't one to
//      check, so the list, the inspector and the server say what Prepare said (needs_you).
//   2. Cut on a part Prepare named as a range ("Opening false starts: “Hello legends, hello again.”", only its start
//      time given) cuts all of it, on safe edges, and leaves no sliver before it (the take's kept part starts 80 ms
//      before the first word).
//   3. Undo in the editor puts the words back and takes the decision back: the part is in To check again.
//   4. A word delete that starts at the take's first word leaves no sliver before the cut either.
//   5. Clocks: Claude's note on a cut ("at 5.5s", take seconds) reads on the cut's clock in the list, and with Play the
//      locked cut on, the canvas timeline's header reads the cut's length, not the take's.
//
//   STUDIO_URL=http://127.0.0.1:4853 node test/cutlist.e2e.mjs
//
// Video Octopus must be running on a throwaway studio (it writes the project cutlist-e2e into
// it). Env: STUDIO_URL; PLAYWRIGHT_PATH (default 'playwright'); HEADED=1 to watch. Nothing goes to Claude (the page's
// chat and step requests are aborted). Prints one line.
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_PATH || 'playwright');
const BASE = (process.env.STUDIO_URL || 'http://127.0.0.1:4853').replace(/\/$/, '');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log('[cut list e2e]', ...a);
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
await api('/api/app/settings', { section: 'help', values: { stepsIntro: 'dismissed' } }).catch(() => {});

// ---- the fixture: 7.5 s, twelve words; the rough cut keeps 0.42–2.6 and 2.9–7.2 (a pause cut), and join-check's fix
// brought back 100 ms of "So" that the rough cut chopped (the join at 2.6 → 3.05 is "likely clipped" in joins.json) ----
const status = await api('/api/status');
const ID = 'cutlist-e2e', DIR = join(status.studio, status.projectsDir || 'projects', ID);
for (const d of ['source', 'work/tr']) mkdirSync(join(DIR, d), { recursive: true });
const W = [[0.5, 0.9, 'Hello'], [1.0, 1.4, 'legends,'], [1.5, 1.9, 'hello'], [2.0, 2.4, 'again.'], [3.0, 3.4, 'So'], [3.5, 3.9, 'for'], [4.0, 4.4, 'this'],
  [4.5, 4.9, 'video'], [5.0, 5.4, 'um'], [5.5, 5.9, 'we'], [6.0, 6.4, 'start'], [6.5, 6.9, 'here.']];
const cam = join(DIR, 'source', 'cl_webcam.mp4');
if (!existsSync(cam)) {
  const expr = W.map(([a, b], i) => `0.3*sin(2*PI*${300 + 20 * i}*t)*between(t\\,${a}\\,${b})`).join('+') + '+0.0003*sin(2*PI*50*t)';
  execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=gray:size=320x180:rate=30', '-f', 'lavfi', '-i', `aevalsrc=${expr}:s=48000`, '-t', '7.5',
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', cam]);
}
const put = (f, v) => writeFileSync(join(DIR, f), typeof v === 'string' ? v : JSON.stringify(v));
put('project.json', { name: 'Cut list e2e', type: 'tutorial' });
put('WORKLOG.md', '# Cut list e2e\n');
put('work/tr/words.json', W);
const ROUGH = [[0.42, 2.6], [2.9, 7.2]];
put('work/rough_map.json', { src_duration: 7.5, segments: [{ src: [0.42, 2.6] }, { src: [3.05, 7.2] }], applied: [1] });
put('work/edl_fixed.json', { segments_sec: ROUGH, from: 'work/rough_map.json' });
put('work/joins.json', { cut: 'work/rough_map.json', joins: [{ k: 0, rank: 1, src_out: 2.6, src_in: 3.05, status: 'likely clipped', score: 0.7, fix_ms: [0, 150], trim_ms: [0, 0],
  out: { why: [] }, in: { word: 'So', chopped_ms: 50, why: ['"So" starts 50 ms before the cut'] } }], summary: { joins: 1, likely_clipped: 1, check: 0 } });
put('work/cuts.json', { duration: 7.5, items: [{ id: 1, start: 2.45, end: 2.95, reason: 'silence', action: 'cut', text: '[pause 0.5s]', note: 'pause 0.5s' },
  { id: 2, start: 5.0, end: 5.4, reason: 'filler', action: 'ask', text: 'um', note: 'hesitation sound; the take goes on at 5.5s' }] });
put('work/prepare.json', { cuts: 1, joins: 1, clipped: 0, needs_you: 2, summary: 'Rough cut: 1 cut, 2 need you', ask: [
  { t: 0.5, what: 'Opening false starts: "Hello legends, hello again." (0:00.1–0:01.9): cut it all?' }, { t: 5.0, what: 'Filler? "um"' },
  { t: 3.05, what: 'Join likely clipped: "So" (fixed: 150 ms back)' }] });
for (const f of ['work/edl_manual.json', 'work/cut_review.json', 'work/notes.json', 'work/package_base.json']) rmSync(join(DIR, f), { force: true });
// The canvas's playback copy (its timeline waits for it), asked again now and then.
await api(`/api/projects/${ID}/proxies`, {});
{ let n = 0; await until('the playback copy', async () => { if (++n % 20 === 0) await api(`/api/projects/${ID}/proxies`, {}).catch(() => {}); return Object.values((await api(`/api/projects/${ID}`)).proxies || {}).filter(Boolean).length >= 1; }, 180000, 500); }
const manual = () => { try { return JSON.parse(readFileSync(join(DIR, 'work/edl_manual.json'), 'utf8')).segments_sec; } catch { return null; } };
const review = () => api(`/api/projects/${ID}/cut-review`);

const browser = await chromium.launch({ headless: !process.env.HEADED, args: ['--autoplay-policy=no-user-gesture-required'] });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
await page.route('**/*', (route) => {
  const r = route.request();
  if (r.method() === 'POST' && /\/(chat|step|send|ask|apply-notes)(\?|$)/.test(r.url())) return route.abort();
  return route.continue();
});
const errors = [], origins = new Set();
page.on('pageerror', (e) => errors.push(e.message));
page.on('request', (r) => { if (/^https?:/.test(r.url())) origins.add(new URL(r.url()).origin); });
const results = [];
let failures = 0;
const expect = (ok, what, detail) => { if (ok) results.push(what); else { failures++; log(`FAIL ${what}: ${JSON.stringify(detail)}`); } };

try {
  // 1. The count, everywhere: 2 (the fixed join isn't one).
  let rv = await review();
  expect(rv.needs === 2 && rv.joins.find((j) => j.k === 0)?.fixed === true && !rv.items.some((x) => x.key === 'j0'), `the count is Prepare's: ${rv.needs} (the join fixed in edl_fixed.json isn't one)`, { needs: rv.needs, joins: rv.joins, items: rv.items.map((x) => x.key) });
  const range = rv.items.find((x) => x.kind === 'Check');
  expect(range && range.a === 0.5 && range.b === 2.4 && range.safe, `the false starts are one part: ${range?.a}–${range?.b} s, on safe edges`, range);

  await page.goto(`${BASE}/#/p/${ID}`);
  await page.waitForSelector('[data-tab=cut]', { timeout: 30000 });
  await page.click('[data-tab=cut]');
  await page.waitForSelector('.cutp [data-a=list]', { timeout: 60000 });
  const frame = await until('the Cut Editor', async () => page.frames().find((f) => f !== page.mainFrame() && /theme=studio/.test(f.url())), 60000);
  await frame.waitForFunction(() => typeof D !== 'undefined' && D && kept.length > 0, null, { timeout: 60000 });
  expect(new URL(frame.url()).origin === BASE && new URL(frame.url()).pathname === '/cut-editor/', `the Cut Editor is built in: ${new URL(frame.url()).pathname} on Video Octopus's own address`, frame.url());
  await sleep(1500); // its first state reaches the inspector
  const ins = await page.evaluate(() => document.querySelector('.cutp .cp-in')?.innerText.replace(/\s+/g, ' ') || '');
  expect(/Still to listen to 2\b/.test(ins) && /1 fixed by Clean up/.test(ins), `the inspector: "${ins}"`, ins);

  // 2. Cut on the false starts: all of it, no sliver before it.
  await page.click('.cutp [data-a=list]');
  await page.waitForSelector('.cp-row[data-k="c2"]', { timeout: 10000 });
  const note = await page.evaluate(() => document.querySelector('.cp-row[data-k="c2"] .cp-note')?.textContent || '');
  // take 5.5 s on the cut [0.42, 2.6] + [2.9, 7.2]: 2.18 + 2.6 = 4.78 → 0:04.8
  expect(/at 0:04\.8\b/.test(note) && !/5\.5s/.test(note), `Claude's note on the cut's clock: "${note}"`, note);
  await page.waitForSelector(`.cp-row[data-k="${range.key}"]`, { timeout: 10000 });
  await page.click(`.cp-row[data-k="${range.key}"] [data-d=cut]`);
  const cutTo = await until('the autosave after Cut', async () => { const m = manual(); return m && m[0][0] > 1 ? m : null; }, 15000);
  rv = await review();
  let it = rv.items.find((x) => x.key === range.key);
  expect(cutTo[0][0] >= 2.4 && cutTo.every(([a, b]) => b - a >= 0.12) && it.decision === 'cut' && it.by === 'list',
    `Cut: the whole range goes (the cut now starts at ${cutTo[0][0]} s, no sliver), decided by the list`, { cutTo, it });

  // 3. Undo in the editor: the words are back and the part is in To check again.
  await frame.evaluate(() => document.getElementById('bUndo').click());
  const back = await until('the autosave after Undo', async () => { const m = manual(); return m && m[0][0] < 0.5 ? m : null; }, 15000);
  rv = await until('the decision taken back', async () => { const r = await review(); return r.items.find((x) => x.key === range.key)?.decision === null ? r : null; }, 10000).catch(() => review());
  it = rv.items.find((x) => x.key === range.key);
  const row = await page.evaluate((k) => Boolean(document.querySelector(`.cp-row[data-k="${k}"]`)), range.key);
  expect(JSON.stringify(back) === JSON.stringify(ROUGH) && it.decision === null && rv.needs === 2 && row, `Undo: the cut is back (${JSON.stringify(back)}) and the part is in To check (${rv.needs} to check)`, { back, it, needs: rv.needs, row });

  // 4. A word delete from the take's first word ("Hello legends,"): no sliver before the cut.
  await frame.evaluate(() => { sel = [words[0][0], words[1][1]]; cut(sel[0], sel[1]); });
  const del = await until('the autosave after the word delete', async () => { const m = manual(); return m && m[0][0] > 1 ? m : null; }, 15000);
  expect(del[0][0] >= 1.4 && del[0][0] < 1.5 && del.every(([a, b]) => b - a >= 0.12), `the first-word delete starts the cut at the take's kept start: first part ${JSON.stringify(del[0])} (no 0.42–0.5 sliver)`, del);

  // 5. The canvas: with Play the locked cut on, the timeline's header is on the cut's clock.
  await page.click('[data-tab=canvas]');
  await page.waitForSelector('#timeline .tl-range', { timeout: 30000 });
  await until('the cut switch', async () => page.evaluate(() => !document.querySelector('#cutWrap')?.hidden), 30000);
  await sleep(800);
  const off = await page.evaluate(() => document.querySelector('#timeline .tl-range')?.textContent || '');
  await page.click('#cutWrap .sw');
  await sleep(600);
  const on = await page.evaluate(() => document.querySelector('#timeline .tl-range')?.textContent || '');
  const len = (await api(`/api/projects/${ID}`)).export.cut.duration, mmss = (t) => `${Math.floor(t / 60)}:${String(Math.round(t % 60)).padStart(2, '0')}`;
  expect(on.endsWith(mmss(len)) && off.endsWith('0:08') && on !== off, `the canvas header: take "${off}", Play the cut on "${on}" (the cut is ${len.toFixed(2)} s)`, { on, off, len });
  expect(!errors.length, 'no page errors', errors);
  expect(origins.size === 1 && origins.has(BASE), 'every request went to Video Octopus itself', [...origins]);
} finally {
  await browser.close();
}
for (const r of results) log(r);
if (failures) { log(`${failures} failed`); process.exit(1); }
console.log(`cut list: ${results.length} checks · ${results.slice(1, 5).join(' · ')}`);
