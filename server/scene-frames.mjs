// The scene's graphics, frame by frame, for the layers export: a headless Chrome (the same one the background
// renderer finds) opens the scene HTML from file:// like the house r.cjs renderers do, and is driven over the
// DevTools protocol with Node's own WebSocket (no packages). For each frame it calls seek(t, layer) and takes a
// screenshot with a transparent page background, so each layer comes out with alpha. The Video Octopus kit's element
// boxes (Octopus.hits) come back with every seek, which is where the motion data comes from.
//
// Separate graphics: a small script patches the 2D canvas so only one element's drawing (inside its Octopus.el)
// reaches the canvas, or only what is drawn outside every element ("rest"). HTML scenes hide the other
// [data-studio] elements instead. A canvas frame where nothing was drawn is known to be empty and skips the screenshot.
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { deflateSync, crc32 } from 'node:zlib';
import { findChrome } from './backgrounds.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// A fully transparent W×H PNG (frames with nothing on them).
export function blankPng(W, H) {
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type, 'latin1'), data]);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td) >>> 0);
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(W, 0); ihdr.writeUInt32BE(H, 4); ihdr[8] = 8; ihdr[9] = 6; // 8-bit RGBA
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(Buffer.alloc(H * (W * 4 + 1)), { level: 9 })), chunk('IEND', Buffer.alloc(0))]);
}

// Runs in the page once it has loaded: counts drawing, filters it by element, and does one frame per call.
const PAGE_SCRIPT = `(() => {
  if (window.__studioLayers) return window.__studioLayers.info;
  const st = window.__studioLayers = { only: null, stack: [], drew: 0 };
  const allow = () => st.only === null || (st.only === '' ? st.stack.length === 0 : st.stack.includes(st.only));
  for (const P of [window.CanvasRenderingContext2D && CanvasRenderingContext2D.prototype, window.OffscreenCanvasRenderingContext2D && OffscreenCanvasRenderingContext2D.prototype]) {
    if (!P) continue;
    for (const m of ['fill', 'stroke', 'fillRect', 'strokeRect', 'fillText', 'strokeText', 'drawImage', 'putImageData']) {
      const f = P[m];
      if (typeof f !== 'function') continue;
      P[m] = function () { if (!allow()) return; st.drew++; return f.apply(this, arguments); };
    }
  }
  const S = window.Octopus;
  if (S && typeof S.el === 'function') {
    const el = S.el;
    S.el = function (id, box, draw, opts) { return el.call(S, id, box, () => { st.stack.push(id); try { return draw(); } finally { st.stack.pop(); } }, opts); };
  }
  const css = document.createElement('style');
  document.head.append(css);
  // Only a canvas scene drawn through the kit can tell an empty frame without a screenshot.
  const html = [...document.body.querySelectorAll('*')].some((e) => !['CANVAS', 'SCRIPT', 'STYLE', 'LINK', 'META', 'TEMPLATE', 'NOSCRIPT'].includes(e.tagName) && e.getBoundingClientRect().width > 0);
  st.info = { kit: (S && S.kit) || 0, layers: (S && S.layers) || [null], countable: Boolean(S && S.ctx) && !html && !document.querySelector('[data-studio]') };
  st.isolate = (only) => {
    st.only = only;
    // HTML scenes: hide the other [data-studio] elements (canvas drawing is filtered above, so the canvas stays visible).
    css.textContent = only === null ? '' : only === '' ? '[data-studio]{visibility:hidden!important}'
      : '[data-studio]:not([data-studio="' + CSS.escape(only) + '"]){visibility:hidden!important}';
  };
  const r1 = (v) => Math.round(v * 10) / 10;
  // measure (kit 2): the kit also reports what each element actually paints (box and opacity), so motion inside an
  // element's own drawing (a title rising, a fade) shows; never on while a frame is captured.
  st.frame = (t, layer, wantHits, measure) => {
    st.drew = 0;
    const m = Boolean(measure && S && S.kit >= 2);
    if (m) S.measuring = true;
    try { window.seek(t, layer == null ? undefined : layer); } finally { if (m) S.measuring = false; }
    const r2 = (v) => Math.round(v * 1000) / 1000;
    const hits = wantHits && S && S.hits ? S.hits.map((k) => [k.id, k.label, k.scene, r1(k.x), r1(k.y), r1(k.w), r1(k.h),
      k.ov ? [r1(k.ov.dx || 0), r1(k.ov.dy || 0), r2(k.ov.scale ?? 1), r2(k.ov.o ?? 1)] : null, Number.isFinite(k.in) && Number.isFinite(k.out) ? [k.in, k.out] : null,
      Boolean(k.keyed), k.m ? [r1(k.m.x), r1(k.m.y), r1(k.m.w), r1(k.m.h), r2(k.o ?? 1)] : null]) : null;
    return { drew: st.drew, hits };
  };
  return st.info;
})()`;

// A DevTools connection: send(method, params) → result; on(event, fn).
function connect(url) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    let n = 0;
    const waiting = new Map(), handlers = new Map();
    const api = {
      send: (method, params = {}) => new Promise((res, rej) => {
        const id = ++n;
        waiting.set(id, { res, rej, method });
        ws.send(JSON.stringify({ id, method, params }));
      }),
      on: (ev, fn) => { if (!handlers.has(ev)) handlers.set(ev, new Set()); handlers.get(ev).add(fn); return () => handlers.get(ev).delete(fn); },
      close: () => { try { ws.close(); } catch {} },
    };
    ws.onopen = () => resolve(api);
    ws.onerror = () => reject(new Error('Could not talk to the headless browser.'));
    ws.onclose = () => { for (const w of waiting.values()) w.rej(new Error('The headless browser closed.')); waiting.clear(); };
    ws.onmessage = (m) => {
      const d = JSON.parse(typeof m.data === 'string' ? m.data : Buffer.from(m.data).toString());
      if (d.id) {
        const w = waiting.get(d.id);
        if (!w) return;
        waiting.delete(d.id);
        if (d.error) w.rej(new Error(`${w.method}: ${d.error.message}`)); else w.res(d.result);
      } else handlers.get(d.method)?.forEach((fn) => fn(d.params));
    };
  });
}

const withTimeout = (p, ms, what) => Promise.race([p, sleep(ms).then(() => { throw new Error(`${what} took longer than ${Math.round(ms / 1000)} s.`); })]);

// One headless Chrome with the scene open at W×H. Returns { info, frame(t, layer, {only, hits, shot}), close() }.
export async function openScene({ file, W, H }) {
  const chrome = findChrome();
  if (!chrome) throw new Error('Scene graphics need Chrome (or Playwright\'s headless shell) to render. Install Google Chrome, or untick the graphics.');
  const profile = mkdtempSync(join(tmpdir(), 'octopus-scene-'));
  const args = ['--remote-debugging-port=0', `--user-data-dir=${profile}`, '--allow-file-access-from-files', '--hide-scrollbars', '--mute-audio',
    '--no-first-run', '--no-default-browser-check', '--disable-extensions', '--disable-background-networking', '--disable-background-timer-throttling',
    '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows', '--force-device-scale-factor=1', `--window-size=${W},${H}`,
    ...(chrome.shell ? [] : ['--headless=new']), 'about:blank'];
  const proc = spawn(chrome.bin, args, { stdio: ['ignore', 'ignore', 'pipe'] });
  let log = '', dead = false;
  proc.stderr.on('data', (d) => { log = (log + d).slice(-3000); });
  proc.on('exit', () => { dead = true; });
  let c = null;
  const close = () => {
    c?.close();
    try { proc.kill('SIGTERM'); } catch {}
    setTimeout(() => { try { proc.kill('SIGKILL'); } catch {} rmSync(profile, { recursive: true, force: true }); }, 1500);
  };
  try {
    // Chrome writes its DevTools port into the profile folder.
    const portFile = join(profile, 'DevToolsActivePort');
    for (let i = 0; i < 300 && !existsSync(portFile); i++) { if (dead) throw new Error(`The headless browser quit: ${log.trim().split('\n').pop() || ''}`); await sleep(50); }
    if (!existsSync(portFile)) throw new Error('The headless browser didn\'t start.');
    const port = readFileSync(portFile, 'utf8').split('\n')[0].trim();
    let pages = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
    let page = pages.find((p) => p.type === 'page');
    if (!page) page = await (await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, { method: 'PUT' })).json();
    c = await connect(page.webSocketDebuggerUrl);
    const errors = [];
    c.on('Runtime.exceptionThrown', (e) => errors.push(e.exceptionDetails?.exception?.description || e.exceptionDetails?.text || 'error'));
    await c.send('Page.enable');
    await c.send('Runtime.enable');
    await c.send('Emulation.setDeviceMetricsOverride', { width: W, height: H, deviceScaleFactor: 1, mobile: false });
    await c.send('Emulation.setDefaultBackgroundColorOverride', { color: { r: 0, g: 0, b: 0, a: 0 } });
    const loaded = new Promise((res) => { const off = c.on('Page.loadEventFired', () => { off(); res(); }); });
    await c.send('Page.navigate', { url: pathToFileURL(file).href });
    await withTimeout(loaded, 60000, 'Opening the scene');
    const ev = async (expression, what, ms = 60000) => {
      const r = await withTimeout(c.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }), ms, what);
      if (r.exceptionDetails) throw new Error(`${what}: ${r.exceptionDetails.exception?.description?.split('\n')[0] || r.exceptionDetails.text}`);
      return r.result.value;
    };
    // The house scenes set window.ready (fonts, images); wait for it and the fonts.
    await ev('Promise.resolve(window.ready).then(() => document.fonts && document.fonts.ready).then(() => typeof window.seek)', 'Loading the scene').then((t) => {
      if (t !== 'function') throw new Error(`The scene has no seek(t) function${errors.length ? ` (${errors[0].split('\n')[0]})` : ''}.`);
    });
    const info = await ev(PAGE_SCRIPT, 'Preparing the scene');
    let only = null;
    return {
      info,
      // shot: false = only the element boxes (measured too, with kit 2). Returns { png: Buffer | null (nothing drawn), hits }.
      async frame(t, layer, { only: o = null, hits = false, shot = true } = {}) {
        if (o !== only) { await ev(`window.__studioLayers.isolate(${JSON.stringify(o)})`, 'Isolating a graphic'); only = o; }
        const r = await ev(`window.__studioLayers.frame(${t}, ${JSON.stringify(layer)}, ${hits}, ${!shot})`, `Drawing ${t.toFixed(2)} s`, 30000);
        if (!shot || (info.countable && r.drew === 0)) return { png: null, hits: r.hits };
        const s = await withTimeout(c.send('Page.captureScreenshot', { format: 'png', fromSurface: true, captureBeyondViewport: false, optimizeForSpeed: true }), 30000, 'A screenshot');
        return { png: Buffer.from(s.data, 'base64'), hits: r.hits };
      },
      errors,
      close,
    };
  } catch (e) { close(); throw e; }
}
