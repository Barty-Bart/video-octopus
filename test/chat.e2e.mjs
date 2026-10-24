// The chat, the step strip and the app shell through the real page, in headless Chromium, against a Video Octopus of its own
// whose chats run a scripted stand-in for Claude Code (test/fake-claude.mjs: Claude Code's stream-json, its
// permission requests and the PreToolUse hooks Video Octopus passes; no model is called).
//   PLAYWRIGHT_PATH=<playwright package> node test/chat.e2e.mjs      (needs ffmpeg; SHOTS=<folder> keeps screenshots)
// It checks, in this order:
//   1. Video Octopus's briefs show as one line ("▶ Clean up", What Video Octopus asked Claude folded) and name the session (first → latest step).
//   2. The document never scrolls: every page, the project page with a long chat and a Show me from its top, focus on
//      the last switch in Settings.
//   3. Clean up's green "done" waits for its turn to end (Running → Done → Next), and the chat's ✓ line comes after
//      Claude's reply.
//   4. A step whose turn ends without its result: "Didn't finish: <reason> · Read" over the strip, Read scrolls the chat
//      to the reply, a reload keeps it; no Undo after a step.
//   5. The chat follows new messages while at the bottom; scrolled up, it stays put and "↓ New message" appears.
//   6. Undo shows only when a reply changed the window's files, says which, and puts them back.
//   7. Claude's proposals: one block after the turn ("Claude proposed 1 shot and 2 zooms"), Show me, Keep all.
//   7b. Auto: a change outside the project asks (the card says where); a change inside it doesn't.
//   8. The Video Octopus assistant's read-only commands get no card; its change still asks.
//   9. With shots made only by sections, the canvas inspector stays on Whole video.
//  10. A reload keeps the tab, a tab's glow until opened, the model tag and the usage meter.
//  11. No console errors and no failed requests on the way (a project with no picture yet included).
// Exits 0 only when every check passed; prints one summary line last.
import { createRequire } from 'node:module';
import { spawn, execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, copyFileSync, chmodSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createServer } from 'node:net';

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_PATH || 'playwright');
const APP = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log('[chat e2e]', ...a);
const must = (c, m) => { if (!c) throw new Error(m); };
const SHOTS = process.env.SHOTS || null;
if (SHOTS) mkdirSync(SHOTS, { recursive: true });

// ---- a Video Octopus of its own: throwaway install folder and studio, the stand-in as Claude Code, Auto mode ----
const ROOT = mkdtempSync(join(tmpdir(), 'studio-chat-e2e-'));
const STUDIO = join(ROOT, 'Video Octopus'), LOCAL = join(ROOT, 'local'), REC = join(STUDIO, 'recordings'), FAKE_LOG = join(ROOT, 'fake-claude.jsonl');
for (const d of [join(STUDIO, 'projects'), LOCAL, REC]) mkdirSync(d, { recursive: true });
const fake = join(ROOT, 'claude');
writeFileSync(fake, `#!${process.execPath}\nimport(${JSON.stringify(pathToFileURL(join(APP, 'test', 'fake-claude.mjs')).href)});\n`);
chmodSync(fake, 0o755);
writeFileSync(join(LOCAL, 'settings.json'), JSON.stringify({ studio: STUDIO, projectsDir: 'projects', recordingsDir: REC, setup: { done: true }, claudePath: fake,
  permissionMode: 'auto', help: { stepsIntro: 'dismissed' }, updates: { auto: false } }, null, 2));
const port = await new Promise((done, fail) => { const s = createServer().on('error', fail).listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => done(p)); }); });
const BASE = `http://127.0.0.1:${port}`;
const server = spawn(process.execPath, [join(APP, 'server', 'index.mjs')], { env: { ...process.env, PORT: String(port), STUDIO_LOCAL_DIR: LOCAL, STUDIO_NO_SCHEDULES: '1',
  FAKE_CLAUDE_LOG: FAKE_LOG, FAKE_CLAUDE_LINGER: '3000' }, stdio: ['ignore', 'pipe', 'pipe'] });
let serverOut = '';
server.stdout.on('data', (d) => { serverOut += d; });
server.stderr.on('data', (d) => { serverOut += d; });
async function api(path, data) {
  const r = await fetch(BASE + path, data === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Studio': '1' }, body: JSON.stringify(data) });
  const text = await r.text();
  let j = null; try { j = JSON.parse(text); } catch {}
  if (!r.ok) throw new Error(`${path}: ${j?.error || r.status}`);
  return j;
}
async function until(what, fn, ms = 20000, every = 150) {
  const t0 = Date.now();
  for (;;) {
    const v = await fn().catch(() => null);
    if (v) return v;
    if (Date.now() - t0 > ms) throw new Error(`timed out waiting for ${what}`);
    await sleep(every);
  }
}
const fakeLog = () => (existsSync(FAKE_LOG) ? readFileSync(FAKE_LOG, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);

const results = [];
let browser = null;
const check = async (name, fn) => {
  const t = Date.now();
  try { const note = await fn(); results.push({ name, ok: true, note: note || '' }); log(`ok   ${name} (${Date.now() - t} ms)${note ? ` · ${note}` : ''}`); }
  catch (e) { results.push({ name, ok: false, note: e.message }); log(`FAIL ${name}: ${e.message}`); }
};

try {
  await until('the server', () => api('/api/status'), 20000, 200);
  // A 3 s take (screen + camera) in the recordings folder, and a project made from it (playback copies included).
  const stamp = '2026-01-02_10-00-00', tk = join(REC, stamp);
  mkdirSync(tk, { recursive: true });
  for (const [kind, src] of [['screen', 'color=c=0x2a4d6e:s=640x360:r=30'], ['webcam', 'testsrc=size=640x360:rate=30']]) {
    execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', src, '-f', 'lavfi', '-i', 'sine=frequency=330:sample_rate=48000', '-t', '3',
      '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', join(tk, `${stamp}_${kind}.mp4`)]);
  }
  const { id } = await api('/api/projects', { name: 'Chat e2e', type: 'tutorial', take: stamp });
  await api('/api/projects', { name: 'No picture yet', type: 'tutorial' });
  const DIR = join(STUDIO, 'projects', id), P = (rel) => join(DIR, rel);
  await until('playback copies', async () => { const v = await api(`/api/projects/${id}`); return Object.values(v.proxies).every(Boolean); }, 60000, 300);

  // A long chat from before, the way older Studios wrote it: a step's start marker, then its brief as a user message,
  // replies and the step's ✓ line (with its hidden "Done: "), many times; the newest brief already carries brief.
  const BRIEF = `Prepare this recording (source/${stamp}_screen.mp4, source/${stamp}_webcam.mp4) in one go: transcribe, rough cut and join check, using the transcribe, rough-cut and join-check skills in that order.\n1. Transcribe the camera file… ${'{"spec": {"cuts": [], "joins": []}} '.repeat(30)}`;
  let ts = Date.now() - 3600e3;
  const ev = [];
  const push = (e) => { ts += 1500; ev.push({ ...e, ts }); };
  push({ t: 'marker', text: 'Clean up' });
  ev.push({ t: 'user', text: BRIEF, ts: ts + 20 });
  for (let k = 0; k < 14; k++) {
    push({ t: 'tool', id: `t${k}`, name: 'Bash', summary: `Step ${k}` });
    push({ t: 'tool_result', id: `t${k}`, text: 'ok' });
    push({ t: 'text', text: `Reply ${k}. ${'Some words about the cut and what changed in it. '.repeat(5)}` });
    push({ t: 'marker', done: true, step: 'sections', text: 'Split into sections', line: '2 sections added', show: { tab: 'canvas', target: 'sections' } });
    push({ t: 'result', ok: true, seconds: 4 });
  }
  push({ t: 'user', text: 'Mark the sections of this YouTube tutorial: propose where each block starts and ends…', brief: { name: 'Split into sections', step: 'sections' } });
  push({ t: 'text', text: 'Two sections.' });
  push({ t: 'result', ok: true, seconds: 3 });
  mkdirSync(join(LOCAL, 'chats'), { recursive: true });
  writeFileSync(join(LOCAL, 'chats', `${id}.jsonl`), ev.map((e) => JSON.stringify(e)).join('\n') + '\n');

  browser = await chromium.launch({ headless: !process.env.HEADED });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const problems = [];
  page.on('console', (m) => { if (m.type() === 'error' || (m.type() === 'warning' && /postMessage|Failed/.test(m.text()))) problems.push(`${m.type()}: ${m.text()} (${m.location()?.url || ''})`); });
  page.on('response', (r) => { if (r.status() >= 400) problems.push(`HTTP ${r.status()} ${r.request().method()} ${r.url()}`); });
  page.on('pageerror', (e) => problems.push(`page error: ${e.message}`));
  const shot = async (name) => { if (SHOTS) await page.screenshot({ path: join(SHOTS, `${name}.png`) }); };
  const open = async (hash) => { await page.goto(`${BASE}/${hash}`); await page.waitForLoadState('domcontentloaded'); };
  const docState = () => page.evaluate(() => ({ sh: document.scrollingElement.scrollHeight, ih: innerHeight, y: scrollY }));
  const msgsState = () => page.evaluate(() => { const m = document.querySelector('#msgs'); return { top: m.scrollTop, gap: m.scrollHeight - m.scrollTop - m.clientHeight, h: m.clientHeight }; });

  await check('briefs show as one line and name the session', async () => {
    await open(`#/p/${id}`);
    await page.waitForSelector('.msg-step');
    const r = await page.evaluate(() => ({
      steps: [...document.querySelectorAll('#msgs .msg-step b')].map((b) => b.textContent),
      users: [...document.querySelectorAll('#msgs .msg-user')].map((u) => u.textContent.slice(0, 40)),
      summary: document.querySelector('#msgs .msg-step summary')?.textContent,
      title: document.querySelector('.sp-t')?.textContent,
    }));
    must(r.steps[0] === 'Clean up' && r.steps.includes('Split into sections'), `step lines: ${JSON.stringify(r.steps)}`);
    must(!r.users.some((u) => /Prepare this recording|Mark the sections/.test(u)), `a brief shows as my message: ${JSON.stringify(r.users)}`);
    must(r.summary === 'What Video Octopus asked Claude', `fold: ${r.summary}`);
    await page.click('#msgs .msg-step summary');
    must(/Prepare this recording/.test(await page.textContent('#msgs .msg-step .ms-text')), 'the brief is not under its fold');
    // A session that ran several steps is named after its first and latest (it ran Clean up, then Split into sections).
    must(r.title === 'Clean up → Split into sections', `the session is named ${JSON.stringify(r.title)}`);
    const s = await api(`/api/projects/${id}/chat-sessions`, { op: 'list' });
    must(s.current.title === 'Clean up → Split into sections', `sessions list: ${s.current.title}`);
    await shot('01-briefs');
    return `${r.steps.length} step lines; session "${s.current.title}"`;
  });

  await check('the document never scrolls (every page; a long chat, Show me from its top; focus in Settings)', async () => {
    const seen = [];
    for (const h of ['#/', '#/dashboard', '#/scheduled', '#/recordings', '#/skills', '#/library', '#/settings', '#/setup']) {
      await open(h); await sleep(900);
      const d = await docState();
      must(d.sh <= d.ih && d.y === 0, `${h}: the page is ${d.sh} px in a ${d.ih} px window (scrolled ${d.y})`);
      seen.push(h);
    }
    // Settings: keyboard focus on every switch, the lowest last.
    await open('#/settings'); await sleep(600);
    await page.evaluate(() => { for (const i of document.querySelectorAll('main input, main select, main button')) i.focus(); });
    await sleep(200);
    let d = await docState();
    must(d.y === 0 && d.sh <= d.ih, `Settings after focus: ${JSON.stringify(d)}`);
    // The project: every tab, then the chat scrolled to its top and a Show me in it.
    await open(`#/p/${id}`); await page.waitForSelector('.marker.done .mk-show');
    for (const t of ['scenes', 'cut', 'publish', 'canvas']) { await page.click(`[data-tab=${t}]`); await sleep(500); d = await docState(); must(d.sh <= d.ih && d.y === 0, `tab ${t}: ${JSON.stringify(d)}`); }
    await page.evaluate(() => { document.querySelector('#msgs').scrollTop = 0; });
    await page.click('.marker.done .mk-show');
    await sleep(900);
    d = await docState();
    await shot('02-after-show-me');
    must(d.sh <= d.ih && d.y === 0, `after Show me: the page is ${d.sh} px and scrolled ${d.y}`);
    return `${seen.length} pages + the project's 5 tabs: ${d.sh} px in ${d.ih}, never scrolled`;
  });

  await check('Clean up: Running until its turn ends, then Done, then Next; the ✓ line after the reply', async () => {
    await open(`#/p/${id}`);
    await page.waitForSelector('.dk-strip.next');
    must(/Clean up/.test(await page.textContent('.dk-strip .dk-name')), 'Clean up is not next');
    await page.click('.dk-strip .dk-run');
    await page.mouse.move(720, 300); // off the strip (a pointer on it keeps the green moment up)
    const states = [];
    let doneAt = null, sawEarly = false;
    const t0 = Date.now();
    while (Date.now() - t0 < 20000) {
      const s = await page.evaluate(() => ({ ok: Boolean(document.querySelector('.dk-strip.ok')), run: Boolean(document.querySelector('.dk-strip.run')),
        ended: /Clean up is done/.test(document.querySelector('#msgs')?.textContent || ''), joins: null }));
      s.joins = existsSync(P('work/joins.json'));
      if (s.joins && s.run && !s.ended) sawEarly = true;
      const last = states.at(-1);
      if (!last || last.ok !== s.ok || last.run !== s.run) states.push(s);
      if (s.ok && !doneAt) { doneAt = s; await shot('03-clean-up-done'); }
      if (doneAt && !s.ok) break;
      await sleep(100);
    }
    must(sawEarly, 'never saw Clean up still running after its result appeared (the test did not exercise the early file)');
    must(doneAt && doneAt.ended, `Done showed before Claude's turn ended: ${JSON.stringify(states)}`);
    const okThenRun = states.findIndex((s, i) => s.run && states.slice(0, i).some((x) => x.ok));
    must(okThenRun < 0, `the strip went back to Running after Done: ${JSON.stringify(states)}`);
    const order = await page.evaluate(() => { const all = [...document.querySelectorAll('#msgs > *')]; const r = all.findIndex((n) => /Clean up is done/.test(n.textContent)); const m = all.findLastIndex((n) => n.matches('.marker.done') && /Clean up/.test(n.textContent)); return { r, m }; });
    must(order.m > order.r && order.r >= 0, `the ✓ line is not after the reply: ${JSON.stringify(order)}`);
    return `strip: ${states.map((s) => (s.ok ? 'done' : s.run ? 'running' : 'next')).join(' → ')}`;
  });

  // Sections done (two take blocks) for the next steps; Lock is then next.
  writeFileSync(P('work/blocks.json'), JSON.stringify({ v: 1, format: 'tutorial', marked: true, blocks: [
    { id: 'intro', type: 'intro', label: 'Intro', order: 0, source: { take: [0, 1.5] } },
    { id: 'body', type: 'body', label: 'Main body', order: 1, source: { take: [1.5, 3] } }] }, null, 1));

  await check('a step that ends without its result: "Didn\'t finish" with Read, kept after a reload, no Undo', async () => {
    await page.waitForFunction(() => /Lock the cut/.test(document.querySelector('.dk-strip.next .dk-name')?.textContent || ''), null, { timeout: 15000 });
    await page.click('.dk-strip.next .dk-run');
    await page.mouse.move(720, 300);
    await page.waitForSelector('.dk-unf', { timeout: 15000 });
    const r = await page.evaluate(() => ({ unf: document.querySelector('.dk-unf')?.textContent.replace(/\s+/g, ' ').trim(), strip: document.querySelector('.dk-strip')?.className, name: document.querySelector('.dk-strip .dk-name')?.textContent,
      undo: [...document.querySelectorAll('.qr')].some((b) => /Undo/.test(b.textContent)) }));
    must(/Didn’t finish: I haven't locked the cut yet, because one join still sounds clipped at 0:42\.1\./.test(r.unf) && /Read/.test(r.unf), `the line: ${r.unf}`);
    must(/next/.test(r.strip) && /Lock the cut/.test(r.name), `the strip: ${r.strip} ${r.name}`);
    must(!r.undo, 'Undo after a step brief');
    await shot('04-didnt-finish');
    // Read: the reply comes into view (the list was scrolled to its top first).
    await page.evaluate(() => { document.querySelector('#msgs').scrollTop = 0; });
    await page.click('.dku-read');
    await sleep(300);
    const seen = await page.evaluate(() => { const m = document.querySelector('#msgs'), n = [...m.querySelectorAll('.msg-ai')].find((x) => /haven't locked the cut/.test(x.textContent)); if (!n) return null; const a = m.getBoundingClientRect(), b = n.getBoundingClientRect(); return { inView: b.top >= a.top - 1 && b.top < a.bottom - 20, flash: n.classList.contains('flash') }; });
    must(seen?.inView && seen.flash, `Read: ${JSON.stringify(seen)}`);
    await shot('05-read');
    await page.reload(); await page.waitForSelector('.dk-unf', { timeout: 10000 });
    const after = await page.textContent('.dk-unf');
    must(/haven't locked the cut yet/.test(after), `after a reload: ${after}`);
    return r.unf;
  });

  await check('the chat follows new messages; scrolled up it stays put and shows "↓ New message"', async () => {
    const send = async (text) => { await page.fill('#input', text); await page.press('#input', 'Enter'); };
    await page.evaluate(() => { const m = document.querySelector('#msgs'); m.scrollTop = m.scrollHeight; });
    await send('LONG-REPLY-8');
    const gaps = [];
    const t0 = Date.now();
    while (Date.now() - t0 < 15000) {
      await sleep(180);
      gaps.push((await msgsState()).gap);
      if (await page.evaluate(() => /Part 8 of 8/.test(document.querySelector('#msgs').textContent) && document.querySelector('#working').hidden)) break;
    }
    await sleep(700); // the quick replies and the dock settle under it
    gaps.push((await msgsState()).gap);
    must(gaps.every((g) => g < 30), `fell behind while following: ${gaps.join(', ')}`);
    must(await page.isHidden('.new-pill'), 'the pill showed while at the bottom');
    // Sending goes to your message; scrolled up after it, Claude's replies don't move the list: the pill appears and
    // takes you down.
    await send('LONG-REPLY-3');
    await page.waitForFunction(() => [...document.querySelectorAll('#msgs .msg-user')].some((u) => u.textContent === 'LONG-REPLY-3'), null, { timeout: 5000 });
    await sleep(120);
    must((await msgsState()).gap < 30, 'sending did not go to the message');
    await page.evaluate(() => { document.querySelector('#msgs').scrollTop = 0; });
    await page.waitForSelector('.new-pill:not([hidden])', { timeout: 10000 });
    await page.waitForFunction(() => /Part 3 of 3/.test(document.querySelector('#msgs').textContent), null, { timeout: 10000 });
    const up = await msgsState(), label = await page.textContent('.new-pill');
    must(up.top < 5, `the list moved while scrolled up: ${JSON.stringify(up)}`);
    must(/New message|new messages/.test(label), `pill: ${label}`);
    await shot('06-new-message-pill');
    await page.click('.new-pill');
    await sleep(200);
    const down = await msgsState();
    must(down.gap < 30 && await page.isHidden('.new-pill'), `after the pill: ${JSON.stringify(down)}`);
    return `${gaps.length} samples within ${Math.max(...gaps)} px of the bottom; pill "${label}"`;
  });

  await check('Undo: only when a reply changed files Video Octopus can put back; it names them and puts them back', async () => {
    const before = readFileSync(P('work/blocks.json'), 'utf8');
    await page.fill('#input', 'MOVE-BLOCKS: rename the intro'); await page.press('#input', 'Enter');
    await page.waitForFunction(() => [...document.querySelectorAll('.qr')].some((b) => /Undo/.test(b.textContent)), null, { timeout: 15000 });
    const label = await page.evaluate(() => [...document.querySelectorAll('.qr')].find((b) => /Undo/.test(b.textContent)).textContent);
    must(label === 'Undo the change to blocks.json', `label: ${label}`);
    must(/Opening/.test(readFileSync(P('work/blocks.json'), 'utf8')), 'the reply did not change blocks.json');
    await shot('07-undo-chip');
    await page.evaluate(() => [...document.querySelectorAll('.qr')].find((b) => /Undo/.test(b.textContent)).click());
    await until('blocks.json back', async () => readFileSync(P('work/blocks.json'), 'utf8') === before, 8000);
    await page.waitForFunction(() => [...document.querySelectorAll('#msgs .note')].some((n) => /Undone: work\/blocks\.json/.test(n.textContent)), null, { timeout: 8000 });
    // A reply that changed nothing: no Undo.
    await page.fill('#input', 'thanks'); await page.press('#input', 'Enter');
    await page.waitForFunction(() => /OK\./.test([...document.querySelectorAll('#msgs .msg-ai')].at(-1)?.textContent || '') && document.querySelector('#working').hidden, null, { timeout: 10000 });
    await sleep(400);
    must(!(await page.evaluate(() => [...document.querySelectorAll('.qr')].some((b) => /Undo/.test(b.textContent)))), 'Undo after a reply that changed nothing');
    const edit = fakeLog().find((x) => x.tool === 'Edit');
    must(edit && !edit.asked && edit.behavior === 'allow', `a change inside the project asked: ${JSON.stringify(edit)}`);
    return `"${label}" put blocks.json back; none after a reply that changed nothing; the edit asked nothing`;
  });

  await check('Claude\'s proposals: one block after the turn, Show me shows one on the picture, Keep all keeps them all', async () => {
    await page.fill('#input', 'PROPOSE-LOOKS for the demo'); await page.press('#input', 'Enter');
    await page.waitForSelector('#msgs .prop-block', { timeout: 15000 });
    const text = (await page.textContent('#msgs .prop-block .pb-t')).trim();
    must(/^Claude proposed 1 shot and 2 zooms/.test(text), `the block: ${text}`);
    await shot('08b-proposals-block');
    await page.click('#msgs .prop-block [data-p=show]');
    await page.waitForFunction(() => /Showing Claude’s proposal · Shot 2/.test(document.querySelector('#propTag:not([hidden]) .pt-t')?.textContent || ''), null, { timeout: 20000 });
    await shot('08c-proposals-show-me');
    const read = (f) => JSON.parse(readFileSync(P(f), 'utf8'));
    must(read('work/shots.json').shots.some((s) => s.status === 'proposed'), 'Show me changed the files');
    await page.click('#msgs .prop-block [data-p=keep]');
    await until('all kept', async () => !read('work/shots.json').shots.some((s) => s.status) && read('work/zooms.json').items.length === 2 && !read('work/zooms.json').items.some((z) => z.status), 10000);
    await page.waitForFunction(() => document.querySelector('#msgs .prop-block')?.classList.contains('decided'), null, { timeout: 8000 });
    return `${text}; Show me → the proposed shot on the picture; Keep all → kept, the block says all decided`;
  });

  await check('Auto: a change outside the project comes back as a card that says where', async () => {
    await page.fill('#input', 'WRITE-OUTSIDE please log this'); await page.press('#input', 'Enter');
    await page.waitForSelector('#msgs .ask:not(.closed)', { timeout: 15000 });
    const why = await page.textContent('#msgs .ask:not(.closed) .ask-why');
    must(why === 'Outside this project: notes/log.md', `the card says: ${why}`);
    await shot('08-outside-card');
    await page.click('#msgs .ask:not(.closed) [data-a="0"]');
    await page.waitForFunction(() => /left the notes alone/.test(document.querySelector('#msgs').textContent), null, { timeout: 10000 });
    must(!existsSync(join(STUDIO, 'notes', 'log.md')), 'the file outside the project was written');
    const b = fakeLog().find((x) => x.tool === 'Bash' && /notes\//.test(x.input?.command || ''));
    must(b?.asked && /^Outside this project/.test(b.reason) && b.behavior === 'deny', `the hook: ${JSON.stringify(b)}`);
    const start = fakeLog().filter((x) => x.start && x.project).at(-1);
    must(start?.mode === 'auto' && start.hooks, `the chat started without the hook: ${JSON.stringify(start)}`);
    return why;
  });

  await check('the Video Octopus assistant: read-only commands without a card, its change still asks', async () => {
    const ctl = new AbortController(), evs = [];
    fetch(`${BASE}/api/projects/_studio/events`, { signal: ctl.signal }).then(async (res) => {
      const rd = res.body.getReader(), dec = new TextDecoder(); let buf = '';
      for (;;) { const { value, done } = await rd.read(); if (done) break; buf += dec.decode(value, { stream: true });
        let i; while ((i = buf.indexOf('\n\n')) >= 0) { const c = buf.slice(0, i); buf = buf.slice(i + 2); if (c.startsWith('data: ')) evs.push(JSON.parse(c.slice(6))); } }
    }).catch(() => {});
    try {
      await api('/api/projects/_studio/chat', { text: 'Which project did I edit last? And turn on the trim lens.' });
      const card = await until('the card for the change', async () => evs.find((e) => e.t === 'permission' && !e.replay), 15000);
      must(/settings set editing\.trimLens/.test(card.detail), `the first card is not the change: ${card.detail}`);
      await api('/api/projects/_studio/answer', { id: card.id, allow: false });
      await until('the reply', async () => evs.some((e) => e.t === 'result' && !e.replay), 10000);
      const cards = evs.filter((e) => e.t === 'permission' && !e.replay).length;
      const bash = fakeLog().filter((x) => x.tool === 'Bash' && !/notes\//.test(x.input?.command || ''));
      must(cards === 1, `${cards} cards`);
      must(bash.length === 3 && bash[0].asked && bash[0].behavior === 'allow' && bash[1].behavior === 'allow' && bash[2].behavior === 'deny', `answers: ${JSON.stringify(bash.map((x) => [x.input.command.slice(-40), x.asked, x.behavior]))}`);
      return `2 read-only commands answered without a card, 1 card for "settings set"`;
    } finally { ctl.abort(); }
  });

  await check('section-made shots: the inspector stays on Whole video', async () => {
    await open(`#/p/${id}`);
    await page.click('[data-tab=canvas]');
    await page.waitForFunction(() => document.querySelector('#shTitle') && !document.querySelector('#shotSec')?.hidden, null, { timeout: 15000 });
    const r = await page.evaluate(() => ({ title: document.querySelector('#shTitle').textContent, sub: document.querySelector('#shSub').textContent, on: Boolean(document.querySelector('.canvas-wrap.shot-on')) }));
    must(r.title === 'Whole video' && !r.on, `inspector: ${JSON.stringify(r)}`);
    await shot('09-whole-video');
    return `${r.title} · ${r.sub}`;
  });

  await check('a reload keeps the tab, a tab\'s glow until opened, the model tag and the usage meter', async () => {
    await page.click('[data-tab=canvas]');
    const pv = Object.values((await api(`/api/projects/${id}`)).proxies).find(Boolean);
    mkdirSync(P('renders'), { recursive: true });
    copyFileSync(P(pv), P('renders/chat-e2e_pip_v1.mp4')); // a new render while you're on Canvas
    await page.waitForSelector('[data-tab=publish].glow', { timeout: 10000 });
    await page.reload(); await page.waitForSelector('[data-tab=canvas].on');
    await page.waitForSelector('[data-tab=publish].glow', { timeout: 10000 });
    const tag = await page.textContent('#sessionInfo'), meter = await page.isVisible('#usage');
    must(/fake-1/.test(tag), `model tag after a reload: "${tag}"`);
    must(meter, 'the usage meter is gone after a reload');
    await shot('10-reload-glow');
    await page.click('[data-tab=publish]');
    await sleep(400);
    await page.reload(); await page.waitForSelector('[data-tab=publish].on', { timeout: 10000 });
    await page.click('[data-tab=canvas]'); await sleep(300);
    must(!(await page.$('[data-tab=publish].glow')), 'the glow came back after Renders was opened');
    return `tab kept, glow kept until opened, "${tag.trim()}", meter shown`;
  });

  await check('no console errors or failed requests on the way', async () => {
    await open('#/'); await sleep(1200); // Home with a project that has no picture yet
    must(!problems.length, problems.slice(0, 6).join(' | '));
    return 'none';
  });
} catch (e) {
  results.push({ name: 'setup', ok: false, note: e.message });
  log(`FAIL setup: ${e.message}\n${serverOut.slice(-1500)}`);
} finally {
  await browser?.close().catch(() => {});
  server.kill();
  if (!process.env.KEEP) rmSync(ROOT, { recursive: true, force: true });
}
const bad = results.filter((r) => !r.ok);
console.log(`${results.length - bad.length} of ${results.length} chat checks passed${bad.length ? `; failed: ${bad.map((b) => `${b.name}: ${b.note}`).join(' | ')}` : ''}`);
process.exit(bad.length ? 1 : 0);
