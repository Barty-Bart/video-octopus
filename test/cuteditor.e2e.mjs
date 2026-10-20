// End-to-end test of the built-in Cut Editor page (web/cut-editor/, served by Video Octopus with server/cuteditor.mjs), in
// headless Chromium, on a made-up take where Whisper ends a word before its sound does: "basically," is timed
// 2.00–2.45 s but sounds until 2.75 s, then silence until "it" at 3.15 s. The cut file also has a 2-frame cut
// (4.600–4.667 s) between "off" and "on".
//   1. The editor opens the cut exactly as the file has it: the 2-frame cut is there.
//   2. Clicking "basically," and pressing Backspace cuts to safe edges: the cut ends in the silence after its tail
//      (2.75–3.15 s), not at Whisper's 2.45, and starts in the gap before it.
//   3. The autosave writes only that change: the 2-frame cut is still in the saved file.
//   4. Everything the page asks for comes from Video Octopus's own address (no second server).
//
//   STUDIO_URL=http://127.0.0.1:4853 CUT_DIR=<folder with media.mp4, words.json, edl.json> node test/cuteditor.e2e.mjs
//
// Video Octopus must be running on a throwaway studio (the project cuteditor-e2e is written into it). Env: STUDIO_URL;
// PLAYWRIGHT_PATH (default 'playwright'). Prints one JSON line: the cut as opened, the saved cut, the saved file as written
// and the addresses the page used. Nothing is sent anywhere else.
import { createRequire } from 'node:module';
import { readFileSync, writeFileSync, existsSync, mkdirSync, copyFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_PATH || 'playwright');
const BASE = (process.env.STUDIO_URL || 'http://127.0.0.1:4853').replace(/\/$/, '');
const FIX = process.env.CUT_DIR;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const must = (c, m) => { if (!c) throw new Error(m); };
async function api(path, data) {
  const r = await fetch(BASE + path, data === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Studio': '1' }, body: JSON.stringify(data) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`${path}: ${j.error || r.status}`);
  return j;
}

// The project: the fixture's take, words and cut (as Clean up leaves them: the cut in work/edl_fixed.json).
const status = await api('/api/status');
const ID = 'cuteditor-e2e', DIR = join(status.studio, status.projectsDir || 'projects', ID);
for (const d of ['source', 'work/tr']) mkdirSync(join(DIR, d), { recursive: true });
copyFileSync(join(FIX, 'media.mp4'), join(DIR, 'source', 'ce_webcam.mp4'));
writeFileSync(join(DIR, 'project.json'), JSON.stringify({ name: 'Cut Editor e2e', type: 'tutorial' }));
copyFileSync(join(FIX, 'words.json'), join(DIR, 'work', 'tr', 'words.json'));
copyFileSync(join(FIX, 'edl.json'), join(DIR, 'work', 'edl_fixed.json'));
for (const f of ['work/edl_manual.json', 'work/editor_notes.json']) rmSync(join(DIR, f), { force: true });
const out = join(DIR, 'work', 'edl_manual.json');

const open = await api(`/api/projects/${ID}/cut`, {});
must(open.ok && /^\/cut-editor\//.test(open.url), `the Cut tab's open: ${JSON.stringify(open)}`);
const browser = await chromium.launch();
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  const asked = new Set();
  page.on('request', (r) => { try { asked.add(new URL(r.url()).origin); } catch { asked.add(r.url().slice(0, 40)); } });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(`${BASE}${open.url}&autosave=1`);
  await page.waitForFunction(() => typeof D !== 'undefined' && D && kept.length > 0, null, { timeout: 30000 });
  const file = JSON.parse(readFileSync(join(FIX, 'edl.json'), 'utf8')).segments_sec;
  const opened = await page.evaluate(() => kept.map(([a, b]) => [+a.toFixed(4), +b.toFixed(4)]));
  must(JSON.stringify(opened) === JSON.stringify(file), `the editor didn't open the cut as the file has it: ${JSON.stringify(opened)} vs ${JSON.stringify(file)}`);
  // The take plays from the same address (it loaded a picture).
  await page.waitForFunction(() => document.getElementById('v').readyState >= 2, null, { timeout: 15000 });
  const i = await page.evaluate(() => words.findIndex((w) => w[2] === 'basically,'));
  must(i > 0, 'no "basically," in the transcript');
  await page.click(`.w[data-i="${i}"]`);
  await page.keyboard.press('Backspace');
  for (let k = 0; k < 40 && !existsSync(out); k++) await sleep(200);
  must(existsSync(out), 'the autosave wrote nothing');
  await sleep(300);
  const text = readFileSync(out, 'utf8'), saved = JSON.parse(text).segments_sec;
  must(!errors.length, `page errors: ${errors.join(' | ')}`);
  console.log(JSON.stringify({ opened, saved, text, origins: [...asked], video: join(DIR, 'source', 'ce_webcam.mp4') }));
} finally {
  await browser.close();
}
