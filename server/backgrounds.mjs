// Canvas backgrounds: the built-in presets (core/kit/night-desk-bg.js: Night Desk, Stars, LED wave),
// the creator's library (<libraryDir>/backgrounds; libraryDir defaults to <studio>/library and the folder is
// only made when something is saved), uploads (copied into the project's assets/), and backgrounds Claude
// writes in code. Drawing lives in web/look.js.
//
// The export renders an animated background before compositing: a headless Chrome (Playwright's headless
// shell or Google Chrome, whichever is on this computer) opens web/bg-render.html, which paints every frame with
// web/look.js in a few workers and posts the PNGs here; ffmpeg turns them into a lossless bg.mkv in the
// export's job folder. Video backgrounds are looped by ffmpeg itself. Either way the export draws the
// background at the same moment the preview does (the export timeline, frame by frame).
import { spawn } from 'node:child_process';
import { copyFileSync, constants, createWriteStream, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync,
  renameSync, rmSync, statSync, appendFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { homedir, tmpdir } from 'node:os';
import { basename, extname, join } from 'node:path';
import { settings, expandHome, inside, studioTool, slugify, APP_DIR, IS_WIN, IS_MAC } from './util.mjs';
import { animatedBg, BG_KINDS, FPS } from '../web/layout.js';

const PORT = Number(process.env.PORT || settings().port || 4800);
const KINDS = { image: /\.(png|jpe?g|webp)$/i, video: /\.(mp4|mov|m4v|webm)$/i, code: /\.m?js$/i };
export const kindOf = (f) => Object.keys(KINDS).find((k) => KINDS[k].test(f)) || null;

export const libraryDir = () => expandHome(settings().libraryDir || '') || join(settings().studio, 'library');
export const backgroundsDir = () => join(libraryDir(), 'backgrounds');
export function libraryFile(name) {
  if (!name || /[/\\]|^\./.test(name) || !kindOf(name)) return null;
  const p = join(backgroundsDir(), name);
  return existsSync(p) ? p : null;
}

// A readable name: a code background's own `name: '…'`, else the file name without "bg-" and the extension.
function nameOf(path, file) {
  if (kindOf(file) === 'code') {
    try { const m = /\bname\s*:\s*(['"`])([^'"`\n]{1,60})\1/.exec(readFileSync(path, 'utf8').slice(0, 4000)); if (m) return m[2]; } catch {}
  }
  const n = basename(file, extname(file)).replace(/^bg-/, '').replace(/[-_]+/g, ' ').trim();
  return n ? n[0].toUpperCase() + n.slice(1) : file;
}
function entries(dir, filter = () => true) {
  try {
    return readdirSync(dir).filter((f) => !f.startsWith('.') && kindOf(f) && filter(f)).map((f) => {
      const p = join(dir, f), st = statSync(p);
      return { file: f, kind: kindOf(f), name: nameOf(p, f), v: Math.round(st.mtimeMs), bytes: st.size };
    }).sort((a, b) => b.v - a.v).slice(0, 60);
  } catch { return []; }
}

// The swatches: the library and this project's own backgrounds (assets/bg-*).
export function listBackgrounds(dir) {
  const library = entries(backgroundsDir());
  const libSizes = new Set(library.map((x) => `${x.name}|${x.bytes}`));
  const project = entries(join(dir, 'assets'), (f) => f.startsWith('bg-'))
    .map((x) => ({ ...x, file: `assets/${x.file}`, inLibrary: libSizes.has(`${x.name}|${x.bytes}`) }));
  return { libraryDir: backgroundsDir(), libraryExists: existsSync(backgroundsDir()), library, project };
}

// A free name in a folder: "<base>.<ext>", then "<base>-2.<ext>", …
function freeName(dir, base, ext) {
  for (let i = 1; ; i++) { const f = `${base}${i > 1 ? `-${i}` : ''}${ext}`; if (!existsSync(join(dir, f))) return f; }
}
const bgFor = (file, name) => ({ kind: kindOf(file), file, name });

// Library → project: the file is cloned into assets/ so the project (and its export jobs) stand on their own.
export function useLibraryBackground(dir, name) {
  const src = libraryFile(name);
  if (!src) throw new Error(`${name} isn't in your library (${backgroundsDir()}).`);
  const assets = join(dir, 'assets');
  mkdirSync(assets, { recursive: true });
  const ext = extname(name).toLowerCase(), base = `bg-${slugify(basename(name, extname(name)).replace(/^bg-/, ''))}`;
  // Already in the project: an image or video of the same size is the same file; a code background is
  // compared by content and updated in place (Claude may have improved it in the library).
  let file = `${base}${ext}`;
  const have = join(assets, file), code = kindOf(name) === 'code';
  if (existsSync(have)) {
    const same = code ? readFileSync(have, 'utf8') === readFileSync(src, 'utf8') : statSync(have).size === statSync(src).size;
    if (same) return bgFor(`assets/${file}`, nameOf(src, name));
    if (!code) file = freeName(assets, base, ext);
  }
  copyFileSync(src, join(assets, file), constants.COPYFILE_FICLONE);
  return bgFor(`assets/${file}`, nameOf(src, name));
}

// Upload: the browser streams the file; it lands in assets/bg-<name>.<ext>.
export async function saveUpload(dir, req, name) {
  const kind = kindOf(name || '');
  if (kind !== 'image' && kind !== 'video') throw new Error('Pick an image (PNG, JPEG, WebP) or a video (MP4, MOV, WebM).');
  const assets = join(dir, 'assets');
  mkdirSync(assets, { recursive: true });
  const ext = extname(name).toLowerCase();
  const file = freeName(assets, `bg-${slugify(basename(name, extname(name)))}`, ext);
  const tmp = join(assets, `.upload-${randomUUID()}`);
  let bytes = 0;
  await new Promise((done, fail) => {
    const out = createWriteStream(tmp);
    req.on('data', (c) => { bytes += c.length; if (bytes > 4e9) { req.destroy(); fail(new Error('That file is over 4 GB.')); } });
    req.on('error', fail);
    out.on('error', fail);
    out.on('finish', done);
    req.pipe(out);
  }).catch((e) => { rmSync(tmp, { force: true }); throw e; });
  if (!bytes) { rmSync(tmp, { force: true }); throw new Error('The file was empty.'); }
  renameSync(tmp, join(assets, file));
  return bgFor(`assets/${file}`, nameOf(join(assets, file), file));
}

// Project → library (made on first save).
export function saveToLibrary(dir, file) {
  const src = typeof file === 'string' && /^assets\/bg-[^/\\]+$/.test(file) ? inside(dir, file) : null;
  if (!src || !existsSync(src)) throw new Error('Only a background from this project can be saved.');
  mkdirSync(backgroundsDir(), { recursive: true });
  const ext = extname(file).toLowerCase(), base = slugify(basename(file, ext).replace(/^bg-/, ''));
  const name = freeName(backgroundsDir(), base, ext);
  copyFileSync(src, join(backgroundsDir(), name), constants.COPYFILE_FICLONE);
  return name;
}

// "Generate…": a brief for the project's Claude to write a background in code.
export function generateBrief(dir, prompt) {
  const slug = slugify(prompt.split(/\s+/).slice(0, 5).join(' ')) || 'background';
  const kitPath = join(APP_DIR, 'core', 'kit', 'night-desk-bg.js');
  return [
    `Make a new background for this project's canvas, in code: "${prompt.trim().slice(0, 600)}"`,
    ``,
    `1. Write it as an ES module at ${join(backgroundsDir(), `${slug}.js`)} (make the folder if it doesn't exist; pick another file name if that one is taken):`,
    '   export default { name: \'<short name>\', draw(g, W, H, t) { … } }',
    `   g is a 2D canvas context of W×H export pixels (1920×1080 or 1080×1920), t is the time in seconds. Paint the whole frame on every call.`,
    `   It must be a pure function of t, so the preview and the export show the same frames: no Math.random() at draw time (precompute with a fixed seed), no Date or performance clocks, no DOM, no images or network. It also runs in a worker (OffscreenCanvas), so only the canvas API. Keep it under ~4 ms a frame at 1920×1080.`,
    `   Size everything from W and H (it is also shown as a small swatch), and keep it calm behind screen recordings.`,
    `2. Follow this project's own style first: its pinned channel brand when it has one (its project context), else the studio's BRAND.md and STYLE.md, when they exist. Otherwise keep it calm: an even field, the same density across the whole frame from left to right; one slow constant drift in one direction; nothing random flying around. Unless the prompt says otherwise, stay close to the default Night Desk look: ground #17171A, cream #F0ECE4 marks, the accent #FF5A1F used sparingly. The built-in backgrounds are a good model: ${kitPath} (stars, LED wave).`,
    `3. Copy it into this project as assets/bg-${slug}.js and set project.json "layout"."bg" to {"kind": "code", "file": "assets/bg-${slug}.js", "name": "<short name>"}. Keep every other layout field as it is. The canvas picks it up by itself, and Export renders it frame by frame.`,
    `Reply in one or two lines: what you made and the file name.`,
  ].join('\n');
}

// ---------- the export's background ----------
// What the export needs for the layout's background: null for still ones (the canvas already painted them
// into the base PNG), else an ffmpeg input plus the filter that fits it to the frame, and for drawn
// backgrounds a prepare() that renders the frames first.
export function backgroundPlan(id, dir, layout, { W, H, total, jobRel }) {
  const bg = layout.bg;
  if (!animatedBg(bg)) return null;
  if (bg.file && !existsSync(inside(dir, bg.file) || '')) throw new Error(`The background file ${bg.file} is missing.`);
  const label = bg.name || BG_KINDS[bg.kind];
  if (bg.kind === 'video') {
    return { bg, label, input: ['-stream_loop', '-1', '-t', total.toFixed(3), '-i', bg.file],
      filter: `fps=${FPS},scale=${W}:${H}:force_original_aspect_ratio=increase:flags=lanczos,crop=${W}:${H},setsar=1,format=rgb24` };
  }
  const out = `${jobRel}/bg.mkv`, frames = Math.ceil(total * FPS - 1e-6) + 1;
  return { bg, label, frames, file: out, input: ['-i', out], filter: 'setpts=PTS-STARTPTS,format=rgb24',
    prepare: (onProgress) => renderFrames({ id, dir, bg, W, H, frames, out, onProgress }) };
}

// A headless browser that can run the canvas code: settings "chrome", Playwright's headless shell, then
// Chrome, Chromium, Edge or Brave. Nothing is installed.
export function findChrome() {
  const own = expandHome(settings().chrome || '');
  if (own && existsSync(own)) return { bin: own, shell: /headless.shell/i.test(own) };
  const win = IS_WIN, mac = IS_MAC;
  const pw = win ? join(process.env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local'), 'ms-playwright')
    : mac ? join(homedir(), 'Library', 'Caches', 'ms-playwright') : join(homedir(), '.cache', 'ms-playwright');
  const versions = (prefix) => { try { return readdirSync(pw).filter((d) => d.startsWith(prefix)).sort((a, b) => Number(b.split('-').pop()) - Number(a.split('-').pop())); } catch { return []; } };
  const shellDirs = win ? [['chrome-headless-shell-win64', 'chrome-headless-shell.exe']]
    : mac ? [['chrome-headless-shell-mac-arm64', 'chrome-headless-shell'], ['chrome-headless-shell-mac-x64', 'chrome-headless-shell']]
    : [['chrome-headless-shell-linux64', 'chrome-headless-shell']];
  for (const d of versions('chromium_headless_shell-'))
    for (const [arch, exe] of shellDirs) {
      const b = join(pw, d, arch, exe);
      if (existsSync(b)) return { bin: b, shell: true };
    }
  const installed = win
    ? [process.env.PROGRAMFILES, process.env['PROGRAMFILES(X86)'], process.env.LOCALAPPDATA].filter(Boolean).flatMap((root) => [
      join(root, 'Google', 'Chrome', 'Application', 'chrome.exe'), join(root, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
      join(root, 'BraveSoftware', 'Brave-Browser', 'Application', 'brave.exe')])
    : mac ? ['/Applications', join(homedir(), 'Applications')].flatMap((root) => ['Google Chrome.app/Contents/MacOS/Google Chrome', 'Chromium.app/Contents/MacOS/Chromium',
      'Microsoft Edge.app/Contents/MacOS/Microsoft Edge', 'Brave Browser.app/Contents/MacOS/Brave Browser'].map((a) => join(root, a)))
    : ['/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/microsoft-edge'];
  for (const b of installed) if (existsSync(b)) return { bin: b, shell: false };
  const fullDirs = win ? [['chrome-win64', 'chrome.exe'], ['chrome-win', 'chrome.exe']]
    : mac ? [['chrome-mac-arm64', 'Chromium.app/Contents/MacOS/Chromium'], ['chrome-mac', 'Chromium.app/Contents/MacOS/Chromium']]
    : [['chrome-linux', 'chrome'], ['chrome-linux64', 'chrome']];
  for (const d of versions('chromium-'))
    for (const [arch, exe] of fullDirs) {
      const b = join(pw, d, arch, exe);
      if (existsSync(b)) return { bin: b, shell: false };
    }
  return null;
}

const bgJobs = new Map(); // token -> job
export const backgroundsBusy = () => bgJobs.size > 0;

// Renders `frames` frames of a drawn background into `out` (relative to the project folder).
// Returns { done: Promise, cancel() }.
function renderFrames({ id, dir, bg, W, H, frames, out, onProgress }) {
  const chrome = findChrome();
  if (!chrome) throw new Error('Animated backgrounds need Chrome (or Playwright\'s headless shell) to render for the export. Install Google Chrome, or pick a still background.');
  const token = randomUUID();
  const ff = spawn(studioTool('ffmpeg'), ['-y', '-v', 'error', '-f', 'image2pipe', '-framerate', String(FPS), '-c:v', 'png', '-i', 'pipe:0',
    '-frames:v', String(frames), '-c:v', 'libx264rgb', '-qp', '0', '-preset', 'veryfast', '-pix_fmt', 'rgb24', out], { cwd: dir });
  const profile = mkdtempSync(join(tmpdir(), 'studio-bg-'));
  const url = `http://127.0.0.1:${PORT}/bg-render.html#${token}`;
  const args = ['--disable-gpu', '--mute-audio', '--no-first-run', '--no-default-browser-check', '--disable-extensions',
    '--disable-background-networking', '--disable-background-timer-throttling', '--disable-renderer-backgrounding',
    `--user-data-dir=${profile}`, ...(chrome.shell ? [] : ['--headless=new']), url];
  const browser = spawn(chrome.bin, args, { stdio: ['ignore', 'ignore', 'pipe'] });
  let log = '', ffErr = '', browserExited = false, ffExited = false;
  browser.stderr.on('data', (d) => { log = (log + d).slice(-4000); });
  ff.stderr.on('data', (d) => { ffErr = (ffErr + d).slice(-2000); });
  ff.stdin.on('error', () => {});

  let settle, state = 'running'; // running → ending (all frames in, ffmpeg finishing) → done | failed
  const done = new Promise((res, rej) => { settle = { res, rej }; });
  const job = {
    token, id, W, H, fps: FPS, frames, next: 0, buf: new Map(), last: Date.now(),
    spec: { W, H, fps: FPS, frames, bg, workers: 6, src: bg.kind === 'code' ? `/api/projects/${encodeURIComponent(id)}/files/${bg.file.split('/').map(encodeURIComponent).join('/')}?v=${Date.now()}` : null },
  };
  const cleanup = () => {
    clearInterval(watch);
    bgJobs.delete(token);
    try { browser.kill('SIGTERM'); } catch {}
    setTimeout(() => {
      if (!browserExited) { try { browser.kill('SIGKILL'); } catch {} }
      rmSync(profile, { recursive: true, force: true });
    }, 1500).unref();
  };
  const fail = (why) => {
    if (state === 'failed' || state === 'done') return;
    state = 'failed';
    cleanup();
    // A failed renderer may never send another PNG. Close its pipe as well as signalling
    // FFmpeg, which otherwise can remain blocked reading stdin after SIGTERM.
    ff.stdin.destroy();
    try { ff.kill('SIGTERM'); } catch {}
    setTimeout(() => { if (!ffExited) { try { ff.kill('SIGKILL'); } catch {} } }, 1500).unref();
    settle.rej(new Error(why));
  };
  job.fail = fail;
  // Frames come in from several workers; they go to ffmpeg strictly in order.
  job.write = async (n, buf) => {
    if (state !== 'running' || n < job.next || n >= frames || job.buf.has(n)) return;
    job.last = Date.now();
    job.buf.set(n, buf);
    while (job.buf.has(job.next)) {
      const b = job.buf.get(job.next);
      job.buf.delete(job.next);
      job.next++;
      onProgress?.(job.next / frames);
      if (!ff.stdin.write(b)) await new Promise((resolve, reject) => {
        const clear = () => { ff.stdin.off('drain', drained); ff.stdin.off('error', broken); ff.stdin.off('close', closed); };
        const drained = () => { clear(); resolve(); }, broken = (e) => { clear(); reject(e); }, closed = () => broken(new Error('The background encoder closed.'));
        ff.stdin.once('drain', drained); ff.stdin.once('error', broken); ff.stdin.once('close', closed);
      });
    }
  };
  job.end = () => {
    if (state !== 'running') return;
    if (job.next < frames) return fail(`The background renderer stopped at frame ${job.next} of ${frames}.`);
    state = 'ending';
    cleanup();
    ff.stdin.end();
  };
  ff.on('exit', (code) => {
    ffExited = true;
    if (state === 'ending' && code === 0) { state = 'done'; settle.res({ out, frames }); }
    else fail(`Encoding the background failed (ffmpeg ${code}): ${ffErr.trim().split('\n').pop() || ''}`);
  });
  ff.on('error', (e) => fail(`Could not start the background encoder: ${e.message}`));
  browser.on('error', (e) => fail(`Could not start the background browser: ${e.message}`));
  browser.on('exit', (code) => { browserExited = true; setTimeout(() => state === 'running' && fail(`The headless browser quit (${code}). ${log.trim().split('\n').filter((l) => /CONSOLE|ERROR/.test(l)).slice(-2).join(' ')}`), 300); });
  // Nothing for 30 s (the page never loaded, or a worker hung): give up.
  const watch = setInterval(() => { if (Date.now() - job.last > 30000) fail(`The background renderer stopped responding (frame ${job.next} of ${frames}).`); }, 2000);
  bgJobs.set(token, job);
  return { done, cancel: () => fail('Export stopped') };
}

// The headless page's API: GET the job, POST frames (PNG bodies), POST done / fail.
export async function bgJobRoute(req, res, p, send) {
  const m = /^\/api\/bgjob\/([\w-]+)(?:\/(frame|done|fail))?$/.exec(p);
  const job = m && bgJobs.get(m[1]);
  if (!job) return send(res, 404, { error: 'No such background job.' });
  if (!m[2]) return send(res, 200, job.spec);
  if (req.method !== 'POST') return send(res, 405, { error: 'POST only' });
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const body = Buffer.concat(chunks);
  if (m[2] === 'frame') {
    const n = Number(new URL(req.url, 'http://x').searchParams.get('n'));
    if (!Number.isInteger(n) || body.length < 8 || body.readUInt32BE(0) !== 0x89504e47) return send(res, 400, { error: 'Not a PNG frame' });
    await job.write(n, body);
    return send(res, 200, { ok: true });
  }
  if (m[2] === 'done') { job.end(); return send(res, 200, { ok: true }); }
  job.fail(`The background renderer failed: ${String(body).slice(0, 300)}`);
  return send(res, 200, { ok: true });
}

// Optional: one line per video that uses an animated background. If the studio has the
// trial notes (settings "trialNotes", off unless set), each project gets
// one line per animated background it exports with.
const TRIAL = { stars: 'Stars', led: 'LED wave' };
export function logTrialUse(dir, rel, { bg, preset, out }) {
  if (!TRIAL[bg?.kind]) return;
  const notes = expandHome(settings().trialNotes || '');
  if (!existsSync(notes)) return;
  try {
    const text = readFileSync(notes, 'utf8');
    const tag = `(${rel}), ${TRIAL[bg.kind]}`;
    if (text.includes(tag)) return;
    const head = '## Video Octopus app exports';
    const line = `- ${new Date().toISOString().slice(0, 10)} · ${basename(dir)} ${tag}, behind ${preset} · ${out} · reaction: (not yet)`;
    appendFileSync(notes, `${text.includes(head) ? '' : `\n${head}\n(one line per project and trial background, written by Video Octopus when it exports)\n`}${line}\n`);
  } catch {}
}
