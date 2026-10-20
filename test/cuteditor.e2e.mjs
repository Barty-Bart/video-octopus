// End-to-end test of the Cut Editor page (starter/tools/cut-editor), in headless Chromium, on a made-up take where
// Whisper ends a word before its sound does: "basically," is timed 2.00–2.45 s but sounds until 2.75 s, then silence
// until "it" at 3.15 s. The cut file also has a 2-frame cut (4.600–4.667 s) between "off" and "on".
//   1. The editor opens the cut exactly as the file has it: the 2-frame cut is there.
//   2. Clicking "basically," and pressing Backspace cuts to safe edges: the cut ends in the silence after its tail
//      (2.75–3.15 s), not at Whisper's 2.45, and starts in the gap before it.
//   3. The autosave writes only that change: the 2-frame cut is still in the saved file.
//
//   CUT_DIR=<folder with media.mp4, words.json, edl.json> CUT_PY=<python with numpy> node test/cuteditor.e2e.mjs
// Env: PLAYWRIGHT_PATH (default 'playwright'), FFMPEG for server.py. Prints one JSON line: the saved cut. Nothing is
// sent anywhere: the editor runs on 127.0.0.1 with this folder only.
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:net';

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_PATH || 'playwright');
const APP = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DIR = process.env.CUT_DIR, PY = process.env.CUT_PY || 'python3';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const must = (c, m) => { if (!c) throw new Error(m); };
const port = await new Promise((done) => { const s = createServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => done(p)); }); });
const out = join(DIR, 'edl_manual.json');
const ed = spawn(PY, [join(APP, 'starter', 'tools', 'cut-editor', 'server.py'), '--video', join(DIR, 'media.mp4'), '--words', join(DIR, 'words.json'),
  '--edl', join(DIR, 'edl.json'), '--out', out, '--port', String(port)], { stdio: ['ignore', 'ignore', 'pipe'] });
let err = '';
ed.stderr.on('data', (d) => { err += d; });
const browser = await chromium.launch();
try {
  const url = `http://127.0.0.1:${port}/`;
  for (let i = 0; ; i++) { try { if ((await fetch(url)).ok) break; } catch {} if (i > 100) throw new Error(`the Cut Editor didn't start: ${err.slice(-300)}`); await sleep(200); }
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  await page.goto(`${url}?autosave=1`);
  await page.waitForFunction(() => typeof D !== 'undefined' && D && kept.length > 0, null, { timeout: 30000 });
  const file = JSON.parse(readFileSync(join(DIR, 'edl.json'), 'utf8')).segments_sec;
  const opened = await page.evaluate(() => kept.map(([a, b]) => [+a.toFixed(4), +b.toFixed(4)]));
  must(JSON.stringify(opened) === JSON.stringify(file), `the editor didn't open the cut as the file has it: ${JSON.stringify(opened)} vs ${JSON.stringify(file)}`);
  const i = await page.evaluate(() => words.findIndex((w) => w[2] === 'basically,'));
  must(i > 0, 'no "basically," in the transcript');
  await page.click(`.w[data-i="${i}"]`);
  await page.keyboard.press('Backspace');
  for (let k = 0; k < 40 && !existsSync(out); k++) await sleep(200);
  must(existsSync(out), 'the autosave wrote nothing');
  await sleep(300);
  const saved = JSON.parse(readFileSync(out, 'utf8')).segments_sec;
  console.log(JSON.stringify({ opened, saved }));
} finally {
  await browser.close();
  ed.kill();
}
