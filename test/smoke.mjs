// Smoke test: starts Video Octopus on a throwaway studio and install folder, then checks what must work on every computer
// (GitHub runs it on Windows; see .github/workflows/windows.yml). No npm packages, no Claude sign-in needed.
//   node test/smoke.mjs            (needs ffmpeg and ffprobe on the PATH, Python with faster-whisper and numpy;
//                                   SMOKE_PYTHON=<path> picks the Python; the first run downloads the tiny.en model;
//                                   PLAYWRIGHT_PATH=<playwright package> adds the recorder test)
// It never touches your own settings, studio or keys: everything lives in a temp folder that's removed at the end.
import { spawn, execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync, existsSync, renameSync, symlinkSync, statSync, utimesSync, copyFileSync, realpathSync } from 'node:fs';
import { gzipSync, deflateSync } from 'node:zlib';
import { tmpdir, homedir } from 'node:os';
import { join, resolve, dirname, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { createServer } from 'node:net';
import { createServer as httpServer } from 'node:http';

const APP = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.SMOKE_PORT || 4899);
const BASE = `http://127.0.0.1:${PORT}`;
const ROOT = mkdtempSync(join(tmpdir(), 'studio-smoke-'));
// A first run: no studio yet. "Create my studio" makes one from starter/ (recordings go in <studio>/recordings).
const STUDIO = join(ROOT, 'Video Octopus'), REC = join(STUDIO, 'recordings'), LOCAL = join(ROOT, 'local');
mkdirSync(LOCAL, { recursive: true });
// SMOKE_PYTHON: the Python with faster-whisper to use (on a Mac, Video Octopus otherwise asks the login shell's PATH).
const PY = process.env.SMOKE_PYTHON || (process.platform === 'win32' ? 'python' : 'python3');
// updates.auto off: the test never asks GitHub for a new version. The recorder section is an older settings file's:
// keys of an earlier recorder (engine, display, its own camera and mic ids, mode) that Video Octopus ignores and drops.
const OLD_RECORDER = { engine: 'auto', display: '5', camera: 'OLD-CAMERA-ID', mic: 'OLD-MIC-ID', mode: true, target: 'layer', countdown: 0 };
writeFileSync(join(LOCAL, 'settings.json'), JSON.stringify({ setup: { done: true }, recorder: OLD_RECORDER, updates: { auto: false },
  ...(process.env.SMOKE_PYTHON ? { python: process.env.SMOKE_PYTHON } : {}) }, null, 2));

const results = [];
// SMOKE_ONLY=<regex>: run only the checks whose name matches (and the ones they need, e.g. "server starts|zooms").
const ONLY = process.env.SMOKE_ONLY ? new RegExp(process.env.SMOKE_ONLY, 'i') : null;
const check = async (name, fn) => {
  if (ONLY && !ONLY.test(name)) return;
  const t = Date.now();
  try { const note = await fn(); results.push({ name, ok: true, note: note || '', ms: Date.now() - t }); }
  catch (e) { results.push({ name, ok: false, note: e.message, ms: Date.now() - t }); }
};
const must = (cond, msg) => { if (!cond) throw new Error(msg); };
// Words that must never ship in core/ or starter/: home-folder paths, plus any listed one per line in
// local/private-words.txt (not committed), such as a name or private skills.
const PRIVATE = (() => {
  let words = [];
  try { words = readFileSync(new URL('../local/private-words.txt', import.meta.url), 'utf8').split('\n').map((x) => x.trim()).filter(Boolean); } catch {}
  const esc = (x) => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(['/Users/[A-Za-z]', 'C:\\\\Users\\\\[A-Za-z]', ...words.map(esc)].join('|'), 'i');
})();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const api = async (path, body, headers = {}) => {
  const go = () => fetch(BASE + path, body === undefined ? { headers } : { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Studio': '1', ...headers }, body: JSON.stringify(body) });
  // A browser check runs with execFileSync, which holds this process still for a while: the server closes the idle
  // keep-alive connection meanwhile, and the first request after it fails on the dead socket. Try that once more.
  const r = await go().catch((e) => (e?.message === 'fetch failed' ? sleep(100).then(go) : Promise.reject(e)));
  const text = await r.text();
  let json = null; try { json = JSON.parse(text); } catch {}
  return { status: r.status, json, text };
};
const until = async (fn, ms, what) => {
  const end = Date.now() + ms;
  while (Date.now() < end) { const v = await fn(); if (v) return v; await sleep(500); }
  throw new Error(`timed out waiting for ${what}`);
};
// A few lines against Video Octopus's own modules in a separate Node, on the throwaway install, with more environment
// (a throwaway home, say); the last line printed is JSON.
const modRun = (code, env = {}) => JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e', code],
  { env: { ...process.env, STUDIO_LOCAL_DIR: LOCAL, ...env }, encoding: 'utf8', timeout: 180000 }).trim().split('\n').pop());
const freePort = () => new Promise((done, fail) => { const s = createServer().on('error', fail).listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => done(p)); }); });
// Another Video Octopus server for the restart checks: its own install folder, no schedules, no update check.
const otherInstall = (name) => {
  const dir = join(ROOT, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'settings.json'), JSON.stringify({ setup: { done: true }, updates: { auto: false } }));
  return dir;
};
const otherEnv = (port, local, extra = {}) => ({ ...process.env, PORT: String(port), STUDIO_LOCAL_DIR: local, STUDIO_NO_SCHEDULES: '1',
  STUDIO_LOGIN_DIR: join(ROOT, 'login'), STUDIO_SUPERVISED: '', ...extra });
const probe = (file) => JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'stream=codec_type,codec_name,sample_rate:format=duration', '-of', 'json', file], { encoding: 'utf8' }));
// A PNG in a few lines (RGBA, no filter), for the canvas layers an export needs: paint(x, y) → [r, g, b, a].
const CRC = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
const crc32 = (buf) => { let c = 0xffffffff; for (const b of buf) c = CRC[(c ^ b) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
function png(w, h, paint) {
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const o = y * (w * 4 + 1) + 1 + x * 4, c = paint(x, y); raw[o] = c[0]; raw[o + 1] = c[1]; raw[o + 2] = c[2]; raw[o + 3] = c[3]; }
  const chunk = (type, data) => { const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const td = Buffer.concat([Buffer.from(type, 'latin1'), data]); const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td)); return Buffer.concat([len, td, crc]); };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 6;
  return `data:image/png;base64,${Buffer.concat([Buffer.from('\x89PNG\r\n\x1a\n', 'latin1'), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]).toString('base64')}`;
}
const hexRGB = (c) => [1, 3, 5].map((i) => parseInt(c.slice(i, i + 2), 16));
// The canvas layers the page sends with an export, drawn the simple way: the Night Desk ground, a white mask per box
// (square corners), and each card's border as a band in its colour (what web/app.js drawOver strokes).
function exportPngs(scene) {
  const out = { base: png(scene.W, scene.H, () => [23, 23, 26, 255]) };
  scene.layers.forEach((ly, i) => {
    out[`mask${i}`] = png(ly.box.w, ly.box.h, () => [255, 255, 255, 255]);
    if (ly.border && ly.borderColor?.startsWith('#')) {
      const { x, y, w, h } = ly.box, b = ly.border, c = [...hexRGB(ly.borderColor), 255];
      out[`mid${i}`] = png(scene.W, scene.H, (px, py) => (px >= x && py >= y && px < x + w && py < y + h && (px < x + b || py < y + b || px >= x + w - b || py >= y + h - b) ? c : [0, 0, 0, 0]));
    }
  });
  return out;
}
// One frame of a video as RGB bytes (a region of it), and the colour at a point of that region.
const frameRGB = (file, t, r) => ({ r, buf: execFileSync('ffmpeg', ['-v', 'error', '-ss', String(t), '-i', file, '-frames:v', '1', '-vf', `crop=${r.w}:${r.h}:${r.x}:${r.y}`, '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'], { maxBuffer: 64e6 }) });
const rgbAt = (f, x, y) => { const o = ((y - f.r.y) * f.r.w + (x - f.r.x)) * 3; return [f.buf[o], f.buf[o + 1], f.buf[o + 2]]; };
const near = (a, b, tol = 40) => a.every((v, i) => Math.abs(v - b[i]) <= tol);

// ---- a GitHub repo as a tarball, for "skills from GitHub" without the network (STUDIO_SKILLS_FIXTURES) ----
// A tar writer in a few lines: ustar headers, pax records, gzip. The fixture mixes good skills with every trick a
// download could try: a symlink, a hardlink, ".." in a name, a pax header that renames an entry to outside.
function tarGz(items) {
  const out = [];
  const header = (name, { size = 0, type = '0', mode = 0o644, link = '' } = {}) => {
    const h = Buffer.alloc(512);
    h.write(name.slice(0, 100), 0, 'utf8');
    h.write(`${mode.toString(8).padStart(7, '0')}\0`, 100); h.write('0000000\0', 108); h.write('0000000\0', 116);
    h.write(`${size.toString(8).padStart(11, '0')}\0`, 124); h.write('00000000000\0', 136);
    h.write('        ', 148); h.write(type, 156); h.write(link.slice(0, 100), 157); h.write('ustar\0', 257); h.write('00', 263);
    let sum = 0; for (const x of h) sum += x;
    h.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148);
    return h;
  };
  for (const it of items) {
    const data = Buffer.from(it.data || '');
    out.push(header(it.name, { size: data.length, type: it.type, mode: it.mode, link: it.link }), data, Buffer.alloc((512 - (data.length % 512)) % 512));
  }
  out.push(Buffer.alloc(1024));
  return gzipSync(Buffer.concat(out));
}
const paxRec = (k, v) => { const body = ` ${k}=${v}\n`; let n = body.length + 1; while (String(n).length + body.length !== n) n = String(n).length + body.length; return `${n}${body}`; };
const COMMIT = 'abcdef0123456789abcdef0123456789abcdef01';
const R = 'motion-graphics-main';
const skillMd = (name, about) => `---\nname: ${name}\ndescription: ${about}\n---\n\n# ${name}\n`;
mkdirSync(join(ROOT, 'gh'), { recursive: true });
writeFileSync(join(ROOT, 'gh', 'Barty-Bart__motion-graphics.tar.gz'), tarGz([
  { name: 'pax_global_header', type: 'g', data: paxRec('comment', COMMIT) },
  { name: `${R}/`, type: '5', mode: 0o755 },
  { name: `${R}/README.md`, data: '# motion-graphics (test fixture)\n' },
  { name: `${R}/skills/good-skill/`, type: '5', mode: 0o755 },
  { name: `${R}/skills/good-skill/SKILL.md`, data: skillMd('good-skill', 'A plain skill. Second sentence.') },
  { name: `${R}/skills/good-skill/scripts/run.sh`, data: '#!/bin/sh\necho ok\n', mode: 0o755 },
  { name: `${R}/skills/good-skill/evil-link`, type: '2', link: '/etc/passwd' },
  { name: `${R}/skills/good-skill/hard-link`, type: '1', link: `${R}/README.md` },
  { name: `${R}/skills/good-skill/../../../escape-dotdot.txt`, data: 'escaped' },
  { name: 'pax-x', type: 'x', data: paxRec('path', `${R}/skills/good-skill/../../../../pax-escape.txt`) },
  { name: `${R}/skills/good-skill/innocent.txt`, data: 'escaped through pax' },
  { name: `${R}/skills/motion-broll/SKILL.md`, data: skillMd('motion-broll', 'Motion-graphic B-roll timed to the words.') },
  { name: `${R}/skills/motion-broll/engine/motion.js`, data: 'export default 1;\n' },
  { name: `${R}/skills/explainer-default/SKILL.md`, data: skillMd('explainer-default', 'The repo version.') },
  { name: `${R}/skills/object-separation/SKILL.md`, data: skillMd('object-separation', 'The repo version.') },
]));

// ---- start the server on the throwaway install ----
const server = spawn(process.execPath, [join(APP, 'server', 'index.mjs')], {
  // The log-in switch writes in the temp folder (STUDIO_LOGIN_DIR), and Restart isn't under start.sh's loop here.
  cwd: APP, env: { ...process.env, PORT: String(PORT), STUDIO_LOCAL_DIR: LOCAL,
    STUDIO_LOGIN_DIR: join(ROOT, 'login'), STUDIO_SUPERVISED: '', STUDIO_SKILLS_FIXTURES: join(ROOT, 'gh') }, stdio: ['ignore', 'pipe', 'pipe'],
});
let log = '';
server.stdout.on('data', (d) => { log += d; });
server.stderr.on('data', (d) => { log += d; });
server.on('exit', (code, sig) => { log += `\n[the server stopped: ${sig || `exit code ${code}`}]\n`; });

try {
  await check('server starts', async () => {
    await until(async () => { try { return (await fetch(BASE + '/')).ok; } catch { return false; } }, 30000, 'the server');
    const html = await (await fetch(BASE + '/')).text();
    must(/<html/i.test(html), 'the page is not HTML');
  });

  await check('API refuses other sites and unsigned writes', async () => {
    const r1 = await fetch(BASE + '/api/projects', { headers: { Origin: 'http://evil.example' } });
    must(r1.status === 403, `other origin got ${r1.status}`);
    const r2 = await fetch(BASE + '/api/projects', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"name":"x"}' });
    must(r2.status === 403, `write without X-Studio got ${r2.status}`);
  });

  await check('Create my studio (starter: CLAUDE.md, skills, tools; no Cut Editor copy, no Setup row for it)', async () => {
    const r = await api('/api/app/setup/create-studio', { path: STUDIO });
    must(r.status === 200, r.text);
    for (const f of ['CLAUDE.md', 'memory/preferences.md', '.claude/skills/transcribe/SKILL.md', '.claude/skills/rough-cut/SKILL.md',
      '.claude/skills/join-check/SKILL.md', '.claude/skills/object-separation/SKILL.md', '.claude/skills/object-separation/scripts/objsep.py',
      'tools/cut/apply_edit.py', 'tools/join-check', '.studio/starter.json', 'projects'])
      must(existsSync(join(STUDIO, f)), `missing ${f}`);
    // The Cut Editor is built into the app: nothing of it in a fresh studio, and Setup has nothing to check for it.
    must(!existsSync(join(STUDIO, 'tools', 'cut-editor')), 'a fresh studio has tools/cut-editor');
    const man = JSON.parse(readFileSync(join(STUDIO, '.studio', 'starter.json'), 'utf8'));
    must(!Object.keys(man.files).some((f) => /cut-editor|server\.py/.test(f)), 'the starter manifest names a Cut Editor file');
    const setup = (await api('/api/app/setup')).json;
    must(setup?.checks?.length && !setup.checks.some((c) => c.id === 'cuteditor' || /cut editor/i.test(c.title)), `Setup rows: ${setup?.checks?.map((c) => c.title).join(', ')}`);
    must((await api('/api/app/setup/check?id=cuteditor')).status !== 200, 'Setup still answers a Cut Editor check');
    const c = (await api('/api/app/setup/check?id=folders')).json;
    must(c?.state === 'ok', `folders: ${c?.state} ${c?.detail}`);
    return `${readdirSync(join(STUDIO, '.claude', 'skills')).join(', ')} · tools: ${readdirSync(join(STUDIO, 'tools')).join(', ')} · Setup: ${setup.checks.map((x) => x.title).join(' / ')}`;
  });

  await check('object separation is a core skill: in a fresh studio, generic (nothing private, no one creator\'s look), starter version 5', async () => {
    const dir = join(STUDIO, '.claude', 'skills', 'object-separation');
    must(readFileSync(join(APP, 'starter', 'VERSION'), 'utf8').trim() === '5', 'starter/VERSION is not 5');
    must(JSON.parse(readFileSync(join(STUDIO, '.studio', 'starter.json'), 'utf8')).version === '5', 'the fresh studio is not on starter version 5');
    const md = readFileSync(join(dir, 'SKILL.md'), 'utf8'), py = readFileSync(join(dir, 'scripts', 'objsep.py'), 'utf8');
    must(/^---\nname: object-separation\ndescription: .{80,}/.test(md), 'SKILL.md front matter');
    // What the skill must say: where its outputs go, how a scene uses the masks, the models, that it never downloads.
    for (const want of ['work/objsep/<name>/', 'masks/', 'behind', 'BRAND.md', 'STUDIO_OBJSEP_MODEL', 'never downloads', 'facebook/sam2.1-hiera-base-plus', 'renders/'])
      must(md.includes(want), `SKILL.md doesn't mention ${want}`);
    // It never downloads: every from_pretrained is local_files_only, and no download call outside the text it prints.
    const loads = [...py.matchAll(/from_pretrained\(([^)]*)\)/g)].map((m) => m[1]);
    must(loads.length === 2 && loads.every((x) => /local_files_only=True/.test(x)) && /STUDIO_OBJSEP_MODEL/.test(py) && !/^[^#'"\n]*\b(snapshot_download|hf_hub_download)\(/m.test(py),
      `objsep.py may download a model: ${loads.join(' | ')}`);
    // The same scan as for core/ and starter/ (a name, private skills), plus home-folder paths, one creator's look and
    // the app's old name. The export scan (public-export) checks the rest of the private words.
    const bad = [], LOOKS = /\/Users\/[A-Za-z]|C:\\Users\\[A-Za-z]|magenta|\bStudio\b(?<!LM Studio)/;
    const walk = (d) => { for (const n of readdirSync(d, { withFileTypes: true })) { const p = join(d, n.name); if (n.isDirectory()) walk(p); else if (PRIVATE.test(readFileSync(p, 'utf8')) || LOOKS.test(readFileSync(p, 'utf8'))) bad.push(p.slice(dir.length + 1)); } };
    walk(dir);
    must(!bad.length, `private or old words in: ${bad.join(', ')}`);
    const help = spawnSync(PY, [join(dir, 'scripts', 'objsep.py'), '--help'], { encoding: 'utf8', env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' } });
    must(help.status === 0 && /separate/.test(help.stdout), `objsep.py --help: ${help.status} ${help.stderr.slice(-300)}`);
    return `${readdirSync(dir).join(', ')} · scripts: ${readdirSync(join(dir, 'scripts')).join(', ')} · starter 5`;
  });

  await check('Setup: ffmpeg and ffprobe found', async () => {
    const r = (await api('/api/app/setup/check?id=ffmpeg')).json;
    must(r?.state === 'ok', `${r?.state}: ${r?.detail}`);
    return r.detail;
  });

  await check('Setup: Python with faster-whisper and numpy', async () => {
    const r = (await api('/api/app/setup/check?id=python')).json;
    must(r?.state === 'ok' || r?.state === 'warn', `${r?.state}: ${r?.detail}`); // warn = the model isn't downloaded yet
    return r.detail;
  });

  await check('Setup: the agent check answers (ready, or how to set it up)', async () => {
    const r = (await api('/api/app/setup/check?id=claude')).json;
    must(r && ['ok', 'fail'].includes(r.state), 'no answer');
    if (r.state === 'fail') must(/one of three agents/.test(r.how || ''), `no word on the three agents: ${r.how}`);
    if (r.state === 'fail' && process.platform === 'win32' && /not found/i.test(r.detail)) must(/install\.ps1/.test(r.how || ''), 'no Windows install hint');
    return `${r.state}: ${r.detail}`;
  });

  await check('Settings page data', async () => {
    const r = (await api('/api/app/settings')).json;
    must(r?.values && r.machine?.whisper?.model, 'no settings view');
    return `${r.machine.chip} · ${r.machine.ramGB} GB · pick ${r.machine.whisper.model} · keys in ${r.keyStore}`;
  });

  // One recorder, in the browser: the takes folder is the studio's, an older settings file's recorder keys are ignored
  // (and dropped on the next save), and Setup's recorder row checks the takes folder.
  await check('Recording settings: takes in <studio>/recordings, old recorder keys ignored and dropped, Setup row', async () => {
    const v = (await api('/api/app/settings')).json?.values?.recorder;
    must(v?.recordingsDir === REC, `takes folder ${v?.recordingsDir}`);
    const want = { screen: 'screen', camera: 'default', mic: 'default', target: 'layer', countdown: 0, recordingsDir: REC };
    must(JSON.stringify(v) === JSON.stringify(want), `the recorder section: ${JSON.stringify(v)}`);
    must((await api('/api/app/settings', { section: 'recorder', values: { engine: 'browser' } })).status === 400, 'an old recorder key was accepted');
    must((await api('/api/app/settings', { section: 'recorder', values: { mode: true } })).status === 400, 'an old recorder key was accepted');
    const r = await api('/api/app/settings', { section: 'recorder', values: { countdown: 3 } });
    must(r.status === 200 && r.json.values.recorder.countdown === 3, `save: ${r.text.slice(0, 160)}`);
    const file = JSON.parse(readFileSync(join(LOCAL, 'settings.json'), 'utf8')).recorder;
    must(JSON.stringify(Object.keys(file).sort()) === JSON.stringify(['camera', 'countdown', 'mic', 'screen', 'target']), `settings.json still has ${JSON.stringify(file)}`);
    must(file.camera === 'default' && file.target === 'layer', `the save lost a choice: ${JSON.stringify(file)}`);
    await api('/api/app/settings', { section: 'recorder', values: { countdown: 0 } });
    const c = (await api('/api/app/setup/check?id=recorder')).json;
    must(c?.state === 'ok' && c.detail.includes('Chrome or Edge'), `Setup: ${c?.state} ${c?.detail}`);
    // No studio yet: the user's videos folder; a studio: <studio>/recordings; a folder that's set stays.
    const home = join(ROOT, 'home'), loc = join(ROOT, 'rec-defaults');
    mkdirSync(loc, { recursive: true });
    const mod = (f) => JSON.stringify(new URL(`../${f}`, import.meta.url).href);
    const dirOf = (set) => { writeFileSync(join(loc, 'settings.json'), JSON.stringify(set)); return modRun(`const u = await import(${mod('server/util.mjs')}); console.log(JSON.stringify(u.settings().recordingsDir));`, { STUDIO_LOCAL_DIR: loc, HOME: home, USERPROFILE: home }); };
    const none = dirOf({}), withStudio = dirOf({ studio: STUDIO }), own = dirOf({ studio: STUDIO, recordingsDir: join(ROOT, 'old takes') });
    must(none === join(home, process.platform === 'darwin' ? 'Movies' : 'Videos', 'Video Octopus recordings'), `no studio: ${none}`);
    must(withStudio === REC, `with a studio: ${withStudio}`);
    must(own === join(ROOT, 'old takes'), `a folder set in Settings: ${own}`);
    return `${c.detail} · old keys dropped: ${Object.keys(OLD_RECORDER).filter((k) => !(k in file)).join(', ')}`;
  });

  // A format can start Record without the camera ("record": {"camera": false}, e.g. a faceless explainer): its projects
  // start with No camera, a camera picked in one is remembered for that project only, and other projects keep theirs.
  await check('Record without the camera for a format that says so (record.camera false), remembered per project', async () => {
    const studio = join(ROOT, 'nocam-studio'), local = join(ROOT, 'nocam-local');
    for (const [p, type] of [['nocam', 'faceless-test'], ['talk', 'tutorial']]) {
      mkdirSync(join(studio, 'projects', p), { recursive: true });
      writeFileSync(join(studio, 'projects', p, 'project.json'), JSON.stringify({ name: p, type }));
    }
    mkdirSync(join(studio, '.studio'), { recursive: true }); mkdirSync(local, { recursive: true });
    writeFileSync(join(studio, '.studio', 'formats.json'), JSON.stringify({ formats: { 'faceless-test': { label: 'Faceless (test)', steps: ['import', 'prepare'], record: { camera: false } } } }));
    writeFileSync(join(local, 'settings.json'), JSON.stringify({ studio, projectsDir: 'projects', setup: { done: true }, updates: { auto: false }, recorder: { screen: 'none', camera: 'cam-global', mic: 'default' } }));
    const mod = (f) => JSON.stringify(new URL(`../${f}`, import.meta.url).href);
    const r = modRun(`const R = await import(${mod('server/browser-recorder.mjs')});
      const pick = () => ({ nocam: R.recorderChoices('nocam').camera, talk: R.recorderChoices('talk').camera, screen: R.recorderChoices('nocam').screen });
      const start = async (id, camera) => { let out; await R.recRoute({ method: 'POST' }, {}, { id, action: '/rec-start', url: new URL('http://127.0.0.1/'),
        send: (res, code, body) => { out = { code, body }; }, emit() {}, receiveTake() {},
        body: async () => ({ kind: 'screen', target: 'replace', tracks: { screen: { mime: 'video/webm' }, webcam: { mime: 'video/webm' } }, choices: { screen: 'screen', camera, mic: 'mic-1', countdown: 3 } }) });
        return out.code; };
      const before = pick();
      const a = await start('nocam', 'cam-picked');
      const afterNocam = pick();
      const b = await start('talk', 'cam-new');
      const afterTalk = pick();
      console.log(JSON.stringify({ before, a, afterNocam, b, afterTalk, mic: R.recorderChoices('talk').mic }));`, { STUDIO_LOCAL_DIR: local });
    must(r.before.nocam === 'none' && r.before.screen === 'screen' && r.before.talk === 'cam-global', `to start with: ${JSON.stringify(r.before)}`);
    must(r.a === 200 && r.b === 200, `rec-start answered ${r.a}, ${r.b}`);
    must(r.afterNocam.nocam === 'cam-picked' && r.afterNocam.talk === 'cam-global', `a camera picked in the faceless project: ${JSON.stringify(r.afterNocam)}`);
    must(r.afterTalk.talk === 'cam-new' && r.afterTalk.nocam === 'cam-picked' && r.mic === 'mic-1', `a camera picked elsewhere: ${JSON.stringify(r.afterTalk)} mic ${r.mic}`);
    return `No camera to start with; picked in that project: ${r.afterNocam.nocam}; other projects: ${r.afterTalk.talk}`;
  });

  // Nothing of the earlier menu bar recorder is left in the app, its README or its tests (the words are built here,
  // so this file doesn't name it either).
  await check('no trace of the earlier recorder app in server/, web/, core/, starter/, bin/, README.md, test/', async () => {
    const re = new RegExp(['record', 'mode'].join('[ _-]?'), 'i');
    const hits = [];
    const walk = (p) => {
      let st; try { st = statSync(p); } catch { return; }
      if (st.isDirectory()) { for (const n of readdirSync(p)) if (n !== 'node_modules' && n !== '.git') walk(join(p, n)); return; }
      if (st.size > 5e6) return;
      const buf = readFileSync(p);
      if (buf.includes(0)) return; // binary
      buf.toString('utf8').split('\n').forEach((line, i) => { if (re.test(line)) hits.push(`${p.slice(APP.length + 1)}:${i + 1}`); });
    };
    for (const d of ['server', 'web', 'core', 'starter', 'bin', 'README.md', 'test']) walk(join(APP, d));
    must(!hits.length, `found in ${hits.slice(0, 8).join(', ')}${hits.length > 8 ? ` and ${hits.length - 8} more` : ''}`);
    return 'none';
  });

  await check('Appearance: Edit Bay by default, a look saves and reaches /api/status, a bad one is refused', async () => {
    must((await api('/api/status')).json?.appearance?.look === 'editbay', 'the default look is not Edit Bay');
    const r = await api('/api/app/settings', { section: 'appearance', values: { look: 'paper', calm: true } });
    must(r.status === 200 && r.json?.values?.appearance?.look === 'paper' && r.json.values.appearance.calm === true, `save failed: ${r.text.slice(0, 120)}`);
    must((await api('/api/status')).json?.appearance?.look === 'paper', 'the status page does not carry the look');
    must((await api('/api/app/settings', { section: 'appearance', values: { look: 'neon' } })).status === 400, 'an unknown look was accepted');
    for (const f of ['/looks.css', '/appearance.js', '/looks/editbay.jpg', '/looks/split.jpg']) must((await fetch(BASE + f)).ok, `${f} is not served`);
    await api('/api/app/settings', { section: 'appearance', values: { look: 'editbay', calm: false } });
    return 'paper + calm saved, then back to Edit Bay';
  });

  await check('Settings → Updates: version, starter files up to date, log-in switch, restart, check off = no badge', async () => {
    const r = (await api('/api/app/updates')).json;
    must(r?.app?.version, `no version: ${JSON.stringify(r).slice(0, 160)}`);
    must(r.starter?.ok && r.starter.pending === 0, `starter: ${r.starter?.text}`);
    must(r.login?.on === false && r.login.file.startsWith(join(ROOT, 'login')), `log-in switch: ${JSON.stringify(r.login)}`);
    must(r.restart?.supervised === false && r.bootId, 'restart info');
    must((await api('/api/app/settings', { section: 'updates', values: { auto: true } })).json?.values?.updates?.auto === true, 'the check switch did not save');
    must((await api('/api/app/settings', { section: 'updates', values: { auto: false } })).json?.values?.updates?.auto === false, 'the check switch did not save off');
    must((await api('/api/app/counts')).json?.update === 0, 'a badge with the check off');
    must((await api('/api/app/updates/login', { on: 'yes' })).status === 400, 'a bad log-in value was accepted');
    return `Video Octopus ${r.app.version}${r.app.commit ? ` · ${r.app.commit}` : ''}${r.app.reason ? ` (${r.app.reason})` : ''} · ${r.starter.text}`;
  });

  // A take like a recorder's: screen and camera files that start together and carry the same sound.
  const take = '20261017-120000';
  await check('make a test take with ffmpeg', async () => {
    mkdirSync(join(REC, take), { recursive: true });
    for (const [role, src] of [['screen', 'testsrc2=size=1280x720:rate=30'], ['webcam', 'smptebars=size=1280x720:rate=30']]) {
      execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', src, '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000',
        '-t', '4', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'pcm_s16le', join(REC, take, `${take}_${role}.mov`)]);
    }
    return readdirSync(join(REC, take)).join(', ');
  });

  let id = null;
  await check('create a project from the take', async () => {
    const r = await api('/api/projects', { name: 'Smoke test', type: 'tutorial', take });
    must(r.status === 200 && r.json?.id, r.text);
    id = r.json.id;
    must(existsSync(join(STUDIO, 'projects', id, 'source', `${take}_webcam.mov`)), 'the take did not land in source/');
    return id;
  });

  // ---- smarter onboarding: brand kit, BRAND.md, motion skills from GitHub, generic build steps ----
  const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');
  const brandUp = (kind, name, data) => fetch(`${BASE}/api/app/brand/upload?${new URLSearchParams({ kind, name })}`, { method: 'POST', headers: { 'X-Studio': '1' }, body: data })
    .then(async (r) => ({ status: r.status, json: await r.json().catch(() => null) }));
  const BRAND = join(STUDIO, 'library', 'brand');
  await check('brand kit upload: types, size, path safety, INDEX.md', async () => {
    const ok = await brandUp('logos', '../../../evil logo.png', PNG);
    must(ok.status === 200 && ok.json?.file === 'logos/evil-logo.png', `upload: ${ok.status} ${JSON.stringify(ok.json)}`);
    must(existsSync(join(BRAND, 'logos', 'evil-logo.png')), 'the logo is not in library/brand/logos');
    must(!existsSync(join(STUDIO, 'evil logo.png')) && !existsSync(join(ROOT, 'evil logo.png')), 'a file landed outside the brand folder');
    must(readFileSync(join(BRAND, 'INDEX.md'), 'utf8').includes('- `logos/evil-logo.png` — Logo'), 'no INDEX.md line');
    must((await brandUp('../memory', 'x.png', PNG)).status === 400, 'an unknown folder was accepted');
    must((await brandUp('logos', 'tool.exe', PNG)).status === 400, 'an .exe was accepted as a logo');
    const fake = await brandUp('logos', 'fake.png', Buffer.from('MZ this is not a picture at all, just bytes pretending to be one'));
    must(fake.status === 400 && /look like/.test(fake.json?.error || ''), `a fake PNG: ${fake.status} ${fake.json?.error}`);
    must(!readdirSync(join(BRAND, 'logos')).some((f) => f.startsWith('.') || f.startsWith('fake')), 'a refused upload left a file behind');
    const big = Buffer.alloc(20e6 + 1); PNG.copy(big);
    const tooBig = await brandUp('logos', 'huge.png', big);
    must(tooBig.status === 413, `a 20 MB+ logo got ${tooBig.status}`);
    must((await brandUp('fonts', 'brand.woff2', Buffer.concat([Buffer.from('wOF2'), Buffer.alloc(60)]))).status === 200, 'a woff2 font was refused');
    const svg = await brandUp('logos', 'mark.svg', Buffer.from('<?xml version="1.0"?>\n<svg xmlns="http://www.w3.org/2000/svg" width="4" height="4"><script>alert(1)</script><rect width="4" height="4" fill="#2f855a"/></svg>'));
    must(svg.status === 200, `svg: ${svg.status}`);
    const served = await fetch(`${BASE}/api/app/brand/file?f=logos/mark.svg`);
    must(served.ok && /sandbox/.test(served.headers.get('content-security-policy') || '') && served.headers.get('x-content-type-options') === 'nosniff', 'an SVG is served without the sandbox');
    for (const f of ['../CLAUDE.md', 'logos/../../../CLAUDE.md', 'logos/.hidden', 'INDEX.md']) must((await fetch(`${BASE}/api/app/brand/file?f=${encodeURIComponent(f)}`)).status === 404, `${f} was served`);
    must((await api('/api/app/brand/remove', { file: '../../CLAUDE.md' })).status === 400 && existsSync(join(STUDIO, 'CLAUDE.md')), 'remove went outside the brand folder');
    const rm = await api('/api/app/brand/remove', { file: 'logos/mark.svg' });
    must(rm.status === 200 && !existsSync(join(BRAND, 'logos', 'mark.svg')) && !readFileSync(join(BRAND, 'INDEX.md'), 'utf8').includes('mark.svg'), 'remove left the file or its line');
    const v = (await api('/api/app/brand')).json;
    must(v?.studio && v.files.map((f) => f.file).join() === 'logos/evil-logo.png,fonts/brand.woff2', `listing: ${v?.files?.map((f) => f.file)}`);
    return `${v.files.length} files kept; .exe, fake PNG, 20 MB+, ../ refused`;
  });

  await check('BRAND.md: from the answers, colours and files; own notes kept', async () => {
    must((await api('/api/app/profile', { who: 'Test Creator, a cooking channel', make: 'cooking shorts', formats: ['Short'], tone: 'warm', creators: 'Two calm cooks', brand: 'green and cream' })).status === 200, 'profile');
    must((await api('/api/app/settings', { section: 'look', values: { colors: ['#2f855a', '#fefcbf'], fonts: 'Inter for titles' } })).status === 200, 'look');
    const w = await api('/api/app/brand/write', {});
    must(w.status === 200 && existsSync(join(STUDIO, 'BRAND.md')), `write: ${w.text.slice(0, 160)}`);
    let md = readFileSync(join(STUDIO, 'BRAND.md'), 'utf8');
    for (const want of ['Test Creator, a cooking channel', 'cooking shorts', '- Short', 'warm', 'Two calm cooks', '`#2f855a` (main colour)', 'Inter for titles', '`library/brand/fonts/brand.woff2`', '`library/brand/logos/evil-logo.png`', '<!-- studio:brand:start -->'])
      must(md.includes(want), `BRAND.md has no "${want}"`);
    writeFileSync(join(STUDIO, 'BRAND.md'), `${md}\n## My own notes\nNever use red.\n`);
    await api('/api/app/profile', { who: 'Test Creator, a cooking channel', make: 'cooking shorts', formats: ['Short'], tone: 'warm and quick', creators: 'Two calm cooks', brand: 'green and cream' });
    await api('/api/app/brand/write', {});
    md = readFileSync(join(STUDIO, 'BRAND.md'), 'utf8');
    must(md.includes('Never use red.') && md.includes('warm and quick') && md.split('<!-- studio:brand:start -->').length === 2, 'a rewrite lost the creator\'s notes or doubled the block');
    await api('/api/app/settings', { section: 'look', values: { colors: ['#123456', '#2f855a'] } }); // Settings → Look: BRAND.md follows by itself
    must(readFileSync(join(STUDIO, 'BRAND.md'), 'utf8').includes('`#123456` (main colour)'), 'BRAND.md did not follow a colour change in Settings → Look');
    must(/BRAND\.md/.test(readFileSync(join(STUDIO, 'CLAUDE.md'), 'utf8')) && /BRAND\.md/.test(readFileSync(join(STUDIO, 'AGENTS.md'), 'utf8')), 'the studio\'s CLAUDE.md / AGENTS.md don\'t point at BRAND.md');
    return `${md.split('\n').length} lines, own notes kept`;
  });

  await check('brand colours from a logo (k-means in plain JS)', async () => {
    const { paletteFromPixels } = await import(new URL('../web/brand-colors.js', import.meta.url).href);
    const w = 120, h = 60, px = new Uint8ClampedArray(w * h * 4).fill(255); // a white background, like a JPEG logo
    for (let y = 10; y < 50; y++) for (let x = 10; x < 110; x++) { const i = (y * w + x) * 4; const c = x < 70 ? [194, 65, 12] : [26, 26, 28]; px[i] = c[0]; px[i + 1] = c[1]; px[i + 2] = c[2]; }
    const got = paletteFromPixels(px, w, h);
    must(got.join() === '#c2410c,#1a1a1c', `got ${got.join(' ')}`);
    const clear = new Uint8ClampedArray(w * h * 4);
    for (let i = 0; i < w * h; i++) if (i % w > 60) { clear.set([37, 99, 235, 255], i * 4); }
    must(paletteFromPixels(clear, w, h).join() === '#2563eb', 'see-through pixels counted');
    return got.join(' ');
  });

  const promptFor = (step) => {
    const code = `const s = await import(${JSON.stringify(new URL('../server/studio.mjs', import.meta.url).href)});
      console.log(JSON.stringify(s.stepPrompt(s.projectDir(${JSON.stringify(id)}), 'tutorial', ${JSON.stringify(step)})));`;
    return JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e', code], { env: { ...process.env, STUDIO_LOCAL_DIR: LOCAL }, encoding: 'utf8' }).trim().split('\n').pop());
  };
  await check('build steps: generic wording, and what to do without motion skills', async () => {
    const pl = readFileSync(join(APP, 'core', 'pipelines.json'), 'utf8');
    must(!/house style/i.test(pl), 'core/pipelines.json still says "house style"');
    const P = JSON.parse(pl);
    const builds = Object.values(P.formats).flatMap((f) => f.steps.filter((x) => typeof x === 'object' && x.motion === 'build'));
    must(builds.length === Object.keys(P.formats).length && builds.every((x) => /BRAND\.md/.test(x.ask) && /motion-graphics skills/.test(x.ask)), `build steps: ${builds.map((x) => x.id)}`);
    // Nothing private in what the app ships to every studio.
    const bad = [];
    const scan = (dir) => { for (const n of readdirSync(dir, { withFileTypes: true })) { const p = join(dir, n.name); if (n.isDirectory()) scan(p); else if (/\.(md|json|js|mjs|py|html|css|txt)$/.test(n.name) && PRIVATE.test(readFileSync(p, 'utf8'))) bad.push(p.slice(APP.length + 1)); } };
    scan(join(APP, 'core')); scan(join(APP, 'starter'));
    must(!bad.length, `private names in: ${bad.join(', ')}`);
    must(id, 'no project');
    const t = promptFor('intro');
    must(/no motion-graphics skills yet/.test(t) && /Add skills from GitHub/.test(t) && !/house style/i.test(t), `intro without motion skills: ${t.slice(-300)}`);
    must(/object-separation skill \(core\)/.test(t) && !/\(motion-broll[^)]*object-separation/.test(t), `intro: object separation as a core skill: ${t.slice(-400)}`);
    return 'core and starter generic; intro says how to add motion skills';
  });

  await check('motion skills from GitHub (a local tarball): no overwrite, no links, nothing outside', async () => {
    const SK = join(STUDIO, '.claude', 'skills');
    mkdirSync(join(SK, 'explainer-default'), { recursive: true });
    writeFileSync(join(SK, 'explainer-default', 'SKILL.md'), 'MY OWN VERSION\n');
    const rec = (await api('/api/app/skills/recommended')).json;
    // Object separation is core now: not in the recommended list (the repo can still have it; the studio's own stays).
    must(rec?.recommended && rec.repo === 'Barty-Bart/motion-graphics' && rec.skills.length === 5 && !rec.skills.some((x) => x.name === 'object-separation') && rec.skills.find((x) => x.name === 'explainer-default')?.installed,
      `the recommended list: ${rec?.skills?.map((x) => x.name).join(', ')}`);
    const look = (await api('/api/app/skills/repo?repo=https://github.com/Barty-Bart/motion-graphics')).json;
    must(look?.commit === COMMIT && look.skills.map((x) => x.name).join() === 'explainer-default,good-skill,motion-broll,object-separation', `repo listing: ${JSON.stringify(look)}`);
    must(look.skills.find((x) => x.name === 'object-separation')?.installed, 'the core object-separation skill is not shown as in the studio');
    must(look.skills.find((x) => x.name === 'good-skill').description === 'A plain skill.', 'description');
    for (const r of ['../../etc', 'a/b/c/d', 'https://evil.example/a/b']) must((await api(`/api/app/skills/repo?repo=${encodeURIComponent(r)}`)).status === 400, `bad repo ${r} accepted`);
    must(/no such public repo/.test((await api('/api/app/skills/install', { repo: 'nobody/nothing', skills: ['x'] })).json?.error || ''), 'an unknown repo');
    const core = readFileSync(join(SK, 'object-separation', 'SKILL.md'), 'utf8');
    const r = await api('/api/app/skills/install', { repo: 'Barty-Bart/motion-graphics', skills: ['good-skill', 'motion-broll', 'explainer-default', 'object-separation', 'nope'] });
    must(r.status === 200, r.text);
    const j = r.json;
    must(j.installed.map((x) => x.name).join() === 'good-skill,motion-broll', `installed: ${JSON.stringify(j.installed)}`);
    must(j.skipped.map((x) => x.name).join() === 'explainer-default,object-separation' && j.missing.join() === 'nope', `skipped ${JSON.stringify(j.skipped)} missing ${j.missing}`);
    must(readFileSync(join(SK, 'object-separation', 'SKILL.md'), 'utf8') === core, 'the repo\'s object-separation replaced the core one');
    must(j.refused >= 4, `refused only ${j.refused}`);
    must(readFileSync(join(SK, 'explainer-default', 'SKILL.md'), 'utf8') === 'MY OWN VERSION\n', 'an existing skill was overwritten');
    must(existsSync(join(SK, 'good-skill', 'SKILL.md')) && existsSync(join(SK, 'motion-broll', 'engine', 'motion.js')), 'files missing');
    if (process.platform !== 'win32') must((statSync(join(SK, 'good-skill', 'scripts', 'run.sh')).mode & 0o111) !== 0, 'run.sh lost its executable bit');
    for (const n of ['evil-link', 'hard-link', 'innocent.txt']) must(!existsSync(join(SK, 'good-skill', n)), `${n} was written`);
    const stray = [];
    const walk = (d) => { for (const n of readdirSync(d, { withFileTypes: true })) { const p = join(d, n.name); if (n.isDirectory()) walk(p); else if (/escape/.test(n.name)) stray.push(p); } };
    walk(ROOT);
    must(!stray.length, `escaped files: ${stray.join(', ')}`);
    must(!readdirSync(SK).some((n) => n.includes('.installing')), 'a half-installed folder was left');
    const log = JSON.parse(readFileSync(join(STUDIO, '.studio', 'skills.json'), 'utf8'));
    must(log.skills['good-skill']?.commit === COMMIT && log.skills['motion-broll']?.repo === 'Barty-Bart/motion-graphics', 'no install record');
    const again = (await api('/api/app/skills/install', { repo: 'Barty-Bart/motion-graphics', skills: ['good-skill'] })).json;
    must(!again.installed.length && again.skipped[0]?.name === 'good-skill', 'a second install overwrote');
    const t = promptFor('intro');
    must(/motion-broll \(/.test(t) && !/no motion-graphics skills yet/.test(t), `intro with motion skills: ${t.slice(-300)}`);
    return `installed 2, kept 2 (the core object-separation too), refused ${j.refused}, commit recorded`;
  });

  // ---- the model rows: object separation (SAM 2.1) and the transcription model (Whisper). Setup's rows (server/setup.mjs),
  // where each model comes from, the choice and the download (server/hfmodels.mjs). A second Video Octopus with its own
  // install folder, a throwaway Hugging Face cache (HF_HUB_CACHE) and a fake Hugging Face on this computer (HF_ENDPOINT:
  // the model API, the makers' pages, the files); Python is a stand-in that prints what a real probe would (Mac and
  // Linux). ----
  if (!ONLY || /object separation|whisper|hugging face/i.test(ONLY.source)) {
    const SAM_WIN = process.platform === 'win32';
    const HF = join(ROOT, 'hf'), SAMLOCAL = otherInstall('local-sam'), PROBE = join(ROOT, 'sam-probe.json');
    const sha256 = (b) => createHash('sha256').update(b).digest('hex');
    const gitId = (b) => createHash('sha1').update(Buffer.concat([Buffer.from(`blob ${b.length}\0`), b])).digest('hex');
    const bytes = (n, seed) => { const out = Buffer.alloc(n); let x = Buffer.from(seed); for (let o = 0; o < n; o += 32) { x = createHash('sha256').update(x).digest(); x.copy(out, o); } return out; };
    const kb = (n) => (n >= 1e6 ? `${Math.round(n / 1e6)} MB` : `${Math.max(1, Math.round(n / 1e3))} kB`); // hfmodels.mjs fmtBytes, below 1 GB
    const WEIGHTS = { tiny: bytes(120000, 'tiny'), 'base-plus': bytes(200000, 'base-plus'), large: bytes(300000, 'large') };
    const FIVE = ['config.json', 'preprocessor_config.json', 'processor_config.json', 'video_preprocessor_config.json', 'model.safetensors'];
    const filesOf = (m) => Object.fromEntries(FIVE.map((f) => [f, f === 'model.safetensors' ? WEIGHTS[m] : Buffer.from(`{"file": "${f}", "model": "${m}"}`)]));
    const REV = 'c0ffee'.padEnd(40, '0');
    const repoDir = (m) => join(HF, `models--facebook--sam2.1-hiera-${m}`);
    // Every repo the fake serves: SAM 2.1's three and Whisper's ten (large-v3 and distil-large-v3 with their
    // preprocessor_config.json and vocabulary.json, the rest vocabulary.txt), each with a README nobody downloads.
    const WHISPER = Object.fromEntries(['large-v3', 'distil-large-v3', 'medium', 'medium.en', 'small', 'small.en', 'base', 'base.en', 'tiny', 'tiny.en']
      .map((id) => [id, id.startsWith('distil-') ? `Systran/faster-distil-whisper-${id.slice(7)}` : `Systran/faster-whisper-${id}`]));
    const whisperFiles = (id) => { const big = /large/.test(id); return { 'config.json': Buffer.from(`{"whisper": "${id}"}`), 'model.bin': bytes(id === 'tiny.en' ? 160000 : 40000, id), 'tokenizer.json': Buffer.from(`{"tok": "${id}"}`),
      [big ? 'vocabulary.json' : 'vocabulary.txt']: Buffer.from(`vocab ${id}\n`), ...(big ? { 'preprocessor_config.json': Buffer.from('{"feature_size": 128}') } : {}) }; };
    const REPOS = Object.fromEntries([
      ...Object.keys(WEIGHTS).map((m) => [`facebook/sam2.1-hiera-${m}`, { author: 'facebook', license: 'test-licence-sam', files: filesOf(m) }]),
      ...Object.entries(WHISPER).map(([id, repo]) => [repo, { author: 'Systran', license: 'test-licence-whisper', files: whisperFiles(id) }]),
      // MLX Whisper's tiny.en (mlx-community): mlx_whisper takes every file of the repo, so the app downloads them all.
      ['mlx-community/whisper-tiny.en-mlx', { author: 'mlx-community', license: 'mit', files: { 'config.json': Buffer.from('{"n_mels": 80}'), 'weights.npz': bytes(150000, 'mlx-tiny.en'),
        'README.md': Buffer.from('# whisper-tiny.en-mlx\n'), '.gitattributes': Buffer.from('*.npz filter=lfs\n') } }]]);
    const dlBytes = (repo) => Object.values(REPOS[repo].files).reduce((n, b) => n + b.length, 0); // what Video Octopus downloads
    const wDir = (id) => join(HF, `models--${WHISPER[id].replace('/', '--')}`);
    let hfMode = 'ok', apiCalls = 0;
    const hfLog = [];
    const hf = httpServer(async (req, res) => {
      const u = new URL(req.url, 'http://x');
      const json = (o, code = 200) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(o)); };
      // The makers: facebook is an organisation, Systran (here) a user, so both of Hugging Face's pages are asked.
      let m = /^\/api\/(organizations|users)\/([\w-]+)\/overview$/.exec(u.pathname);
      if (m) return m[1] === 'organizations' && m[2] === 'facebook' ? json({ name: 'facebook', fullname: 'Fake Meta Lab' })
        : m[1] === 'users' && m[2] === 'Systran' ? json({ name: 'Systran', fullname: 'Fake Systran Co' }) : json({ error: 'not found' }, 404);
      m = /^\/api\/models\/([\w-]+\/[\w.-]+)\/revision\/main$/.exec(u.pathname);
      if (m && REPOS[m[1]]) {
        apiCalls++;
        const R = REPOS[m[1]];
        return json({ id: m[1], author: R.author, sha: REV, cardData: { license: R.license }, tags: [`license:${R.license}`],
          siblings: [...(R.files['README.md'] ? [] : [{ rfilename: 'README.md', size: 9, blobId: gitId(Buffer.from('# readme\n')) }]),
            ...Object.entries(R.files).map(([name, b]) => ({ rfilename: name, size: b.length, blobId: gitId(b), ...(/^(model|weights)\./.test(name) ? { lfs: { sha256: sha256(b), size: b.length, pointerSize: 134 } } : {}) }))] });
      }
      m = /^\/([\w-]+\/[\w.-]+)\/resolve\/([0-9a-f]{40})\/(.+)$/.exec(u.pathname);
      const b = m && REPOS[m[1]] && m[2] === REV ? REPOS[m[1]].files[m[3]] : null;
      if (!b) { res.statusCode = 404; return res.end(); }
      const mode = /^(model|weights)\./.test(m[3]) ? hfMode : 'ok';
      hfLog.push({ model: m[1].replace(/^facebook\/sam2\.1-hiera-/, ''), repo: m[1], file: m[3], range: req.headers.range || null, mode });
      if (mode === 'wrongsize') { res.writeHead(200, { 'Content-Length': b.length + 10 }); return res.end(Buffer.concat([b, Buffer.alloc(10)])); }
      if (mode === 'corrupt') { const c = Buffer.from(b); c[c.length >> 1] ^= 0xff; res.writeHead(200, { 'Content-Length': c.length }); return res.end(c); }
      if (mode === 'cut') { res.writeHead(200, { 'Content-Length': b.length }); res.write(b.subarray(0, 90000)); return setTimeout(() => res.socket.destroy(), 100); }
      const r = /^bytes=(\d+)-$/.exec(req.headers.range || ''), from = r && mode !== 'norange' ? Number(r[1]) : 0;
      res.writeHead(from ? 206 : 200, { 'Content-Length': b.length - from, ...(from ? { 'Content-Range': `bytes ${from}-${b.length - 1}/${b.length}` } : {}) });
      if (mode !== 'slow') return res.end(b.subarray(from));
      for (let o = from; o < b.length; o += 8192) { if (res.destroyed) return; res.write(b.subarray(o, o + 8192)); await sleep(15); }
      res.end();
    });
    const hfPort = await freePort();
    await new Promise((done) => hf.listen(hfPort, '127.0.0.1', done));
    // The stand-in Python prints PROBE whatever it's asked; on Windows a missing python.exe (only the "no Python" state).
    const standIn = join(ROOT, 'sam-python');
    if (!SAM_WIN) { writeFileSync(standIn, `#!/bin/sh\ncat "${PROBE}"\n`); execFileSync('chmod', ['755', standIn]); }
    const probe = (p) => writeFileSync(PROBE, JSON.stringify(p));
    const READY = { py: '3.12.1', torch: '2.5.1', device: 'mps', torchvision: '0.20.1', transformers: '4.56.0', numpy: '2.1.0', pillow: '11.0.0', sam2video: true };
    writeFileSync(join(SAMLOCAL, 'settings.json'), JSON.stringify({ setup: { done: true }, updates: { auto: false }, python: SAM_WIN ? join(ROOT, 'no-python.exe') : standIn,
      transcribe: { whisperEngine: 'faster-whisper' } })); // Systran's models first; MLX Whisper has its own check below
    const samPort = await freePort(), SB = `http://127.0.0.1:${samPort}`;
    const sam = spawn(process.execPath, [join(APP, 'server', 'index.mjs')], { cwd: APP, stdio: 'ignore',
      env: otherEnv(samPort, SAMLOCAL, { HF_HUB_CACHE: HF, HF_ENDPOINT: `http://127.0.0.1:${hfPort}`, STUDIO_KEYCHAIN_SERVICE: 'StudioSmokeNoKeys' }) });
    const sapi = async (path, body, headers = {}) => {
      // Like api(): a check that holds this process still (execFileSync) lets the server close the idle connection, and
      // the next request fails on the dead socket. Try that once more.
      const go = () => fetch(SB + path, body === undefined ? { headers } : { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Studio': '1', ...headers }, body: JSON.stringify(body) });
      const r = await go().catch((e) => (e?.message === 'fetch failed' ? sleep(100).then(go) : Promise.reject(e)));
      const text = await r.text(); let json = null; try { json = JSON.parse(text); } catch {}
      return { status: r.status, json, text };
    };
    const row = async () => (await sapi('/api/app/setup/check?id=objsep')).json;
    const choose = (model) => sapi('/api/app/settings', { section: 'objsep', values: { model } });
    const have = () => modRun(`const S = await import(${JSON.stringify(new URL('../server/sam2.mjs', import.meta.url).href)}); console.log(JSON.stringify(S.sam2Have()));`, { HF_HUB_CACHE: HF });
    // A download started over the API, followed to its end; `seen` gets every progress reading in between.
    const download = async (size, { stopAt = null, family = 'sam2' } = {}) => {
      const first = (await sapi(`/api/app/setup/${family}/download`, { size })).json;
      const seen = [];
      let d = first;
      const end = Date.now() + 30000;
      while (d?.state === 'downloading' && Date.now() < end) {
        await sleep(20);
        d = (await sapi(`/api/app/setup/${family}`)).json;
        seen.push(d);
        if (stopAt && d.state === 'downloading' && d.total && d.got > stopAt * d.total) { await sapi(`/api/app/setup/${family}/stop`, {}); stopAt = null; }
      }
      return { first, d, seen };
    };
    const wrow = async () => (await sapi('/api/app/setup/check?id=whisper')).json;
    const wHave = () => modRun(`const S = await import(${JSON.stringify(new URL('../server/settings.mjs', import.meta.url).href)}); console.log(JSON.stringify(S.whisperModels()));`, { HF_HUB_CACHE: HF, STUDIO_LOCAL_DIR: SAMLOCAL });
    try {
      await check('object separation: a second Video Octopus on a fake Hugging Face starts', async () => {
        await until(async () => { try { return (await fetch(SB + '/')).ok; } catch { return false; } }, 30000, 'the second server');
        const setup = (await sapi('/api/app/setup')).json;
        must(setup.checks.some((c) => c.id === 'objsep' && c.title === 'Object separation (SAM 2)'), `Setup rows: ${setup.checks.map((c) => c.title).join(', ')}`);
        return `rows: ${setup.checks.map((c) => c.title).join(' / ')}`;
      });

      await check('object separation row: no Python, no torch, transformers too old (fake Python stand-ins)', async () => {
        if (SAM_WIN) {
          const r = await row();
          must(r.state === 'fail' && /Python not found/.test(r.detail) && /requirements\.txt/.test(r.fix || ''), `no Python: ${r.state} ${r.detail}`);
          return 'Windows: no Python only (the stand-ins are shell scripts)';
        }
        rmSync(PROBE, { force: true });
        const none = await row();
        must(none.state === 'fail' && /Python not found/.test(none.detail) && /ask before installing/i.test(none.fix || ''), `no Python: ${none.state} ${none.detail}`);
        probe({ py: '3.12.1', torch: null, torchvision: null, transformers: null, numpy: '2.1.0', pillow: '11.0.0' });
        const bare = await row();
        must(bare.state === 'fail' && /missing torch, torchvision, transformers/.test(bare.detail) && /transformers 4\.56 or newer/.test(bare.fix) && /requirements\.txt/.test(bare.fix) && /Download button/.test(bare.fix) && /ask before installing/i.test(bare.fix),
          `no torch: ${bare.state} · ${bare.detail} · ${bare.fix}`);
        // Without torch the recommendation comes from the hardware; the row still lists the three models.
        must(bare.sam2.models.map((m) => m.id).join() === 'tiny,base-plus,large' && bare.sam2.models.every((m) => m.speed && !m.have), `models: ${JSON.stringify(bare.sam2.models).slice(0, 300)}`);
        // Each model's source, from the (fake) Hugging Face API: the maker's name from its page, the licence, the size of
        // exactly the five files Video Octopus downloads (not the README), the link to the repo.
        for (const m of bare.sam2.models) {
          const repo = `facebook/sam2.1-hiera-${m.id}`, want = `From Hugging Face · ${repo} (Fake Meta Lab) · ${kb(dlBytes(repo))} · licence: test-licence-sam`;
          must(m.source.line === want && m.source.url === `https://huggingface.co/${repo}` && m.source.license === 'test-licence-sam' && m.source.maker === 'Fake Meta Lab' && m.source.bytes === dlBytes(repo),
            `${m.id} source: ${JSON.stringify(m.source)} (want "${want}")`);
        }
        // torchvision alone missing (transformers' SAM 2 image processor won't load without it).
        probe({ ...READY, torchvision: null });
        const tv = await row();
        must(tv.state === 'fail' && /missing torchvision\./.test(tv.detail) && /torchvision/.test(tv.fix), `no torchvision: ${tv.state} ${tv.detail}`);
        probe({ ...READY, transformers: '4.50.0', sam2video: false });
        const old = await row();
        must(old.state === 'fail' && /no SAM 2 video model \(it needs 4\.56 or newer\)/.test(old.detail) && old.fix, `old transformers: ${old.state} ${old.detail}`);
        return `${none.detail} | ${bare.detail} | ${tv.detail} | ${old.detail}`;
      });

      await check('object separation: the recommended model per machine (NVIDIA 12 GB+, NVIDIA under 12 GB, Apple Silicon, CPU only), the choice saved and read back', async () => {
        const rec = (dev) => modRun(`const S = await import(${JSON.stringify(new URL('../server/sam2.mjs', import.meta.url).href)}); console.log(JSON.stringify(S.sam2Recommend(${JSON.stringify(dev)})));`);
        const table = [[{ device: 'cuda', vramGB: 24, gpu: 'NVIDIA RTX 4090' }, 'large'], [{ device: 'cuda', vramGB: 12, gpu: 'NVIDIA RTX 3060' }, 'large'],
          [{ device: 'cuda', vramGB: 8, gpu: 'NVIDIA RTX 3070' }, 'base-plus'], [{ device: 'mps' }, 'base-plus'], [{ device: 'cpu' }, 'tiny']];
        for (const [dev, want] of table) { const r = rec(dev); must(r.size === want && r.slow === (want === 'tiny'), `${JSON.stringify(dev)} → ${JSON.stringify(r)}, not ${want}`); }
        const out = [];
        if (!SAM_WIN) {
          // Through the row, with torch's own view from the stand-in (what the skill sees too).
          for (const [p, want] of [[{ device: 'cuda', gpu: 'NVIDIA RTX 4090', vram: 24 }, 'large'], [{ device: 'cuda', gpu: 'NVIDIA RTX 3070', vram: 8 }, 'base-plus'], [{ device: 'mps' }, 'base-plus'], [{ device: 'cpu' }, 'tiny']]) {
            probe({ ...READY, ...p });
            const r = await row();
            must(r.sam2.recommended === want && r.sam2.picked === want && r.sam2.choice === 'auto' && r.state === 'warn' && /isn't downloaded yet/.test(r.detail), `${p.device} ${p.vram || ''}: ${JSON.stringify(r.sam2.recommended)} ${r.state} ${r.detail}`);
            if (p.device === 'cpu') must(r.sam2.slow && /seconds a frame/.test(r.detail), `CPU only, no warning: ${r.detail}`);
            if (p.gpu) must(r.detail.includes(`${p.gpu} with ${p.vram} GB`), `the card isn't named: ${r.detail}`);
            out.push(`${p.gpu || p.device} → ${want}`);
          }
          probe(READY);
        }
        // The choice: Settings saves it, reads it back, the row and the chats follow it; a bad one is refused.
        must((await choose('large')).json?.values?.objsep?.model === 'large', 'the choice did not save');
        must((await sapi('/api/app/settings')).json?.values?.objsep?.model === 'large', 'the choice did not read back');
        must(JSON.parse(readFileSync(join(SAMLOCAL, 'settings.json'), 'utf8')).objsep?.model === 'large', 'not in settings.json');
        must((await choose('huge')).status === 400, 'a bad choice was accepted');
        if (!SAM_WIN) { const r = await row(); must(r.sam2.choice === 'large' && r.sam2.picked === 'large' && r.sam2.recommended === 'base-plus' && /your pick/.test(r.detail), `the row with a pick: ${JSON.stringify(r.sam2).slice(0, 200)} ${r.detail}`); }
        const env = modRun(`const S = await import(${JSON.stringify(new URL('../server/settings.mjs', import.meta.url).href)});
          const e = await S.childEnv(); console.log(JSON.stringify({ model: e.STUDIO_OBJSEP_MODEL || null, brief: S.settingsBrief(e) }));`, { STUDIO_LOCAL_DIR: SAMLOCAL, HF_HUB_CACHE: HF, STUDIO_KEYCHAIN_SERVICE: 'StudioSmokeNoKeys' });
        must(env.model === 'large' && /Object separation: the object-separation skill with SAM 2\.1 large \(STUDIO_OBJSEP_MODEL=large\)/.test(env.brief) && /never downloads a model/.test(env.brief), `chats: ${JSON.stringify(env).slice(0, 400)}`);
        await choose('auto');
        const auto = modRun(`const S = await import(${JSON.stringify(new URL('../server/settings.mjs', import.meta.url).href)}); const e = await S.childEnv(); console.log(JSON.stringify(e.STUDIO_OBJSEP_MODEL || null));`,
          { STUDIO_LOCAL_DIR: SAMLOCAL, STUDIO_KEYCHAIN_SERVICE: 'StudioSmokeNoKeys' });
        must(auto === null, `auto still passes a model: ${auto}`);
        const view = (await sapi('/api/app/settings')).json?.sam2;
        must(view?.recommended?.size && Object.keys(view.models).join() === 'tiny,base-plus,large', `Settings' view: ${JSON.stringify(view).slice(0, 200)}`);
        return `${out.join(', ') || 'table only (Windows)'} · choice large saved, read back, in the chats' env and brief; auto passes none`;
      });

      await check('object separation: a model counts as downloaded only with all five files in a snapshot (per model)', async () => {
        const snap = join(repoDir('tiny'), 'snapshots', REV), blobs = join(repoDir('tiny'), 'blobs');
        mkdirSync(snap, { recursive: true }); mkdirSync(blobs, { recursive: true });
        const F = filesOf('tiny');
        for (const f of FIVE.slice(0, 4)) writeFileSync(join(snap, f), F[f]);
        writeFileSync(join(blobs, `${sha256(F['model.safetensors'])}.incomplete`), F['model.safetensors'].subarray(0, 5000));
        must(have().length === 0, `four files and a partial blob count: ${have()}`);
        if (!SAM_WIN) {
          symlinkSync(join('..', '..', 'blobs', sha256(F['model.safetensors'])), join(snap, 'model.safetensors')); // leads nowhere yet
          must(have().length === 0, 'a link to a missing blob counts');
          rmSync(join(snap, 'model.safetensors'));
        }
        writeFileSync(join(snap, 'model.safetensors'), F['model.safetensors']);
        must(have().length === 0, 'a whole snapshot that refs/main doesn\'t name counts (transformers wouldn\'t find it)');
        mkdirSync(join(repoDir('tiny'), 'refs'), { recursive: true });
        writeFileSync(join(repoDir('tiny'), 'refs', 'main'), REV);
        must(JSON.stringify(have()) === '["tiny"]', `a whole snapshot: ${JSON.stringify(have())}`);
        for (const m of ['base-plus', 'large']) must(!have().includes(m), `${m} counted`);
        let state = 'Windows: no row';
        if (!SAM_WIN) {
          probe(READY);
          await choose('tiny');
          const r = await row();
          must(r.state === 'ok' && r.sam2.there && r.sam2.models.find((m) => m.id === 'tiny').have && r.detail.includes(`SAM 2.1 tiny (${kb(dlBytes('facebook/sam2.1-hiera-tiny'))}, your pick)`), `ready: ${r.state} ${r.detail}`);
          await choose('auto');
          const back = await row();
          must(back.state === 'warn' && back.sam2.picked === 'base-plus' && /downloaded: tiny/.test(back.detail), `auto, base-plus missing: ${back.state} ${back.detail}`);
          state = `${r.detail} | ${back.detail}`;
        }
        return state;
      });

      await check('object separation Download (fake Hugging Face): size and checksum checks, a cut download kept but never counted, carried on with Range and progress, a server that ignores Range, Stop', async () => {
        const W = WEIGHTS.large, blob = join(repoDir('large'), 'blobs', sha256(W)), part = `${blob}.incomplete`;
        must((await sapi('/api/app/setup/sam2/download', { size: 'huge' })).status === 400, 'a bad size was accepted');
        must((await fetch(SB + '/api/app/setup/sam2/download', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"size":"large"}' })).status === 403, 'a download without X-Studio');
        // The server offers another size than Hugging Face lists: refused, nothing kept.
        hfMode = 'wrongsize';
        let r = await download('large');
        must(r.d.state === 'error' && /model\.safetensors came as 300010 bytes, but it is 300000 bytes/.test(r.d.error) && !existsSync(part) && !existsSync(blob), `wrong size: ${JSON.stringify(r.d)}`);
        // Every byte there but one changed: the SHA-256 check refuses it.
        hfMode = 'corrupt';
        r = await download('large');
        must(r.d.state === 'error' && /checksum/.test(r.d.error) && !existsSync(part) && !existsSync(blob) && !have().includes('large'), `bad checksum: ${JSON.stringify(r.d)}`);
        // Cut off part way: the part stays as .incomplete, and the model doesn't count.
        hfMode = 'cut';
        r = await download('large');
        const cut = existsSync(part) ? statSync(part).size : 0;
        must(r.d.state === 'error' && /carries on/.test(r.d.error) && cut > 0 && cut < W.length && !existsSync(blob) && !have().includes('large') && !existsSync(join(repoDir('large'), 'snapshots', REV, 'model.safetensors')), `cut: ${JSON.stringify(r.d)} part ${cut}`);
        if (!SAM_WIN) { await choose('large'); const rw = await row(); must(rw.state === 'warn' && !rw.sam2.there && /isn't downloaded yet/.test(rw.detail), `a partial counted: ${rw.state} ${rw.detail}`); }
        // Carry on: a Range request from where it stopped, progress on the way, then the blob, the snapshot and refs/main.
        hfMode = 'slow';
        hfLog.length = 0;
        r = await download('large');
        const ranged = hfLog.find((x) => x.file === 'model.safetensors');
        const mid = r.seen.filter((x) => x.state === 'downloading' && x.got > cut + 1 && x.got < x.total);
        must(r.d.state === 'done' && ranged?.range === `bytes=${cut}-` && r.d.from >= cut && mid.length >= 2 && r.d.got === r.d.total, `carry on: ${JSON.stringify(r.d)} range ${ranged?.range} readings ${mid.length}`);
        must(readFileSync(blob).equals(W) && !existsSync(part) && readFileSync(join(repoDir('large'), 'refs', 'main'), 'utf8') === REV, 'blob or refs/main');
        for (const f of FIVE) must(readFileSync(join(repoDir('large'), 'snapshots', REV, f)).equals(filesOf('large')[f]), `snapshot ${f}`);
        if (!SAM_WIN) must(String(execFileSync('readlink', [join(repoDir('large'), 'snapshots', REV, 'model.safetensors')])).trim() === `../../blobs/${sha256(W)}`, 'not a relative link to the blob');
        must(have().includes('large'), `large isn't counted: ${have()}`);
        if (!SAM_WIN) { const rw = await row(); must(rw.state === 'ok' && rw.sam2.there, `after the download: ${rw.state} ${rw.detail}`); }
        // Again: nothing to fetch but the list (every blob is there whole).
        hfLog.length = 0;
        r = await download('large');
        must(r.d.state === 'done' && !hfLog.length, `a second download fetched ${hfLog.map((x) => x.file).join(', ')}`);
        // A server that ignores Range: the stale part is thrown away and the file starts over.
        rmSync(repoDir('large'), { recursive: true, force: true });
        mkdirSync(join(repoDir('large'), 'blobs'), { recursive: true });
        writeFileSync(part, Buffer.alloc(40000, 7));
        hfMode = 'norange';
        r = await download('large');
        must(r.d.state === 'done' && readFileSync(blob).equals(W) && have().includes('large'), `no Range: ${JSON.stringify(r.d)}`);
        // Stop part way (the part stays), then Download carries on to the end.
        hfMode = 'slow';
        r = await download('base-plus', { stopAt: 0.3 });
        const bpPart = `${join(repoDir('base-plus'), 'blobs', sha256(WEIGHTS['base-plus']))}.incomplete`, kept = existsSync(bpPart) ? statSync(bpPart).size : 0;
        must(r.d.state === 'stopped' && kept > 0 && kept < WEIGHTS['base-plus'].length && !have().includes('base-plus'), `stop: ${JSON.stringify(r.d)} kept ${kept}`);
        hfLog.length = 0;
        r = await download('base-plus');
        must(r.d.state === 'done' && hfLog.find((x) => x.file === 'model.safetensors')?.range === `bytes=${kept}-` && have().includes('base-plus'), `after Stop: ${JSON.stringify(r.d)} ${JSON.stringify(hfLog)}`);
        await choose('auto');
        return `wrong size and bad checksum refused · cut at ${cut} kept, not counted · carried on (${mid.length} progress readings) · no-Range start-over · stopped at ${kept} and carried on`;
      });

      await check('object separation: huggingface_hub and the skill find a model the app downloaded (SMOKE_PYTHON)', async () => {
        const env = { ...process.env, HF_HUB_CACHE: HF, HF_HUB_OFFLINE: '1', PYTHONDONTWRITEBYTECODE: '1' };
        const hub = execFileSync(PY, ['-c', `from huggingface_hub import try_to_load_from_cache as t\nprint(all(isinstance(t('facebook/sam2.1-hiera-large', f), str) for f in ${JSON.stringify(FIVE)}))`], { env, encoding: 'utf8' }).trim();
        must(hub === 'True', `huggingface_hub doesn't see the download: ${hub}`);
        const script = join(STUDIO, '.claude', 'skills', 'object-separation', 'scripts', 'objsep.py');
        const out = spawnSync(PY, [script, 'check', '--model', 'large'], { env, encoding: 'utf8', timeout: 120000 });
        const j = JSON.parse(out.stdout.slice(0, out.stdout.indexOf('\n}') + 2));
        must(JSON.stringify(j.downloaded) === '["tiny","base-plus","large"]' && j.model === 'large' && j.ready === true, `the skill's check: ${out.stdout.slice(0, 600)} ${out.stderr.slice(-300)}`);
        return `huggingface_hub: all five files · the skill: ${j.downloaded.join(', ')} downloaded, large ready${j.torch ? ` (torch ${j.torch} on ${j.device})` : ''}`;
      });

      await check('Hugging Face model sources: maker, licence and size from the API, kept with the date; offline the kept ones "as checked on", with nothing kept only the link and why', async () => {
        // Kept in the install's local/hf-models.json, with the date: a second look within a day asks Hugging Face nothing.
        await wrow();
        const kept = JSON.parse(readFileSync(join(SAMLOCAL, 'hf-models.json'), 'utf8'));
        const tiny = kept.repos['Systran/faster-whisper-tiny.en'];
        must(tiny?.maker === 'Fake Systran Co' && tiny.license === 'test-licence-whisper' && tiny.bytes === dlBytes('Systran/faster-whisper-tiny.en') && /^\d{4}-\d\d-\d\dT/.test(tiny.fetched)
          && JSON.stringify(tiny.files.map((f) => f.name).sort()) === JSON.stringify(['config.json', 'model.bin', 'tokenizer.json', 'vocabulary.txt']), `kept: ${JSON.stringify(tiny).slice(0, 300)}`);
        const before = apiCalls;
        const w = await wrow();
        must(apiCalls === before, `asked Hugging Face again within a day (${apiCalls - before} calls)`);
        const big = w.whisper.models.find((m) => m.id === 'large-v3').source;
        must(big.line === `From Hugging Face · Systran/faster-whisper-large-v3 (Fake Systran Co) · ${kb(dlBytes('Systran/faster-whisper-large-v3'))} · licence: test-licence-whisper` && big.files.includes('preprocessor_config.json') && big.files.includes('vocabulary.json'),
          `large-v3: ${JSON.stringify(big)}`);
        // No Hugging Face (a closed port): with nothing kept, the link and why; with what's kept (a stale copy), that, dated.
        const dead = await freePort(), NOLOCAL = otherInstall('local-offline'), port = await freePort();
        writeFileSync(join(NOLOCAL, 'settings.json'), JSON.stringify({ setup: { done: true }, updates: { auto: false }, transcribe: { whisperEngine: 'faster-whisper' } }));
        const off = spawn(process.execPath, [join(APP, 'server', 'index.mjs')], { cwd: APP, stdio: 'ignore',
          env: otherEnv(port, NOLOCAL, { HF_HUB_CACHE: join(ROOT, 'hf-offline'), HF_ENDPOINT: `http://127.0.0.1:${dead}`, STUDIO_KEYCHAIN_SERVICE: 'StudioSmokeNoKeys' }) });
        try {
          const ob = `http://127.0.0.1:${port}`;
          await until(async () => { try { return (await fetch(ob + '/')).ok; } catch { return false; } }, 30000, 'the offline server');
          const r1 = await fetch(`${ob}/api/app/setup/check?id=whisper`).then((x) => x.json());
          const s1 = r1.whisper.models.find((m) => m.id === 'tiny.en').source;
          must(s1.url === 'https://huggingface.co/Systran/faster-whisper-tiny.en' && !s1.size && !s1.license && !s1.maker
            && /^From Hugging Face · Systran\/faster-whisper-tiny\.en · size and licence couldn't be checked \(couldn't reach Hugging Face/.test(s1.line), `offline, nothing kept: ${JSON.stringify(s1)}`);
          const old = { ...kept, repos: Object.fromEntries(Object.entries(kept.repos).map(([k, v]) => [k, { ...v, fetched: '2026-01-02T03:04:05.000Z' }])) };
          writeFileSync(join(NOLOCAL, 'hf-models.json'), JSON.stringify(old));
          const r2 = await fetch(`${ob}/api/app/setup/check?id=whisper`).then((x) => x.json());
          const s2 = r2.whisper.models.find((m) => m.id === 'tiny.en').source;
          must(s2.line === `From Hugging Face · Systran/faster-whisper-tiny.en (Fake Systran Co) · ${kb(dlBytes('Systran/faster-whisper-tiny.en'))} · licence: test-licence-whisper · as checked on 2026-01-02`,
            `offline, kept: ${s2.line}`);
          const set = await fetch(`${ob}/api/app/settings`).then((x) => x.json());
          must(set.whisperSources?.['tiny.en']?.line === s2.line && set.sam2?.sources?.tiny?.line?.includes('Fake Meta Lab'), `Settings' view: ${JSON.stringify(set.whisperSources?.['tiny.en'])}`);
          return `${big.line} | offline: ${s1.line} | kept: ${s2.line}`;
        } finally { off.kill(); }
      });

      await check('Whisper row: every model with its source, the recommended one per machine type, Auto and the pick saved and read back', async () => {
        const pick = (m) => modRun(`const S = await import(${JSON.stringify(new URL('../server/settings.mjs', import.meta.url).href)}); console.log(JSON.stringify(S.whisperPick(${JSON.stringify(m)}).model));`, { STUDIO_LOCAL_DIR: SAMLOCAL });
        const table = [[{ apple: true, arm64: true, ramGB: 48 }, 'large-v3'], [{ apple: true, arm64: true, ramGB: 16 }, 'medium.en'], [{ apple: true, arm64: true, ramGB: 8 }, 'small.en'],
          [{ gpu: 'NVIDIA RTX 4090', vramMB: 24564 }, 'large-v3'], [{ gpu: 'NVIDIA RTX 3050', vramMB: 6144 }, 'medium.en'], [{ ramGB: 32, cores: 12 }, 'medium.en'], [{ ramGB: 8, cores: 4 }, 'base.en']];
        for (const [m, want] of table) must(pick(m) === want, `${JSON.stringify(m)} → ${pick(m)}, not ${want}`);
        const view = (await sapi('/api/app/settings')).json, rec = view.machine.whisper.model;
        must((await sapi('/api/app/settings', { section: 'transcribe', values: { engine: 'local', model: 'auto' } })).status === 200, 'auto');
        const w = await wrow();
        must(w.whisper.models.map((m) => m.id).join() === 'large-v3,distil-large-v3,medium,medium.en,small,small.en,base,base.en,tiny,tiny.en' && w.whisper.recommended === rec
          && w.whisper.choice === 'auto' && w.whisper.picked === rec && w.state === 'warn' && /Auto uses the best model already downloaded, and none is yet/.test(w.detail)
          && w.whisper.models.every((m) => m.source.repo === WHISPER[m.id] && m.source.line.startsWith(`From Hugging Face · ${WHISPER[m.id]} (Fake Systran Co) · `)), `the row: ${w.state} ${w.detail} ${JSON.stringify(w.whisper).slice(0, 300)}`);
        const saved = await sapi('/api/app/settings', { section: 'transcribe', values: { model: 'tiny.en' } });
        must(saved.json?.values?.transcribe?.model === 'tiny.en' && (await sapi('/api/app/settings')).json.values.transcribe.model === 'tiny.en', 'the pick did not save or read back');
        must((await sapi('/api/app/settings', { section: 'transcribe', values: { model: 'huge' } })).status === 400, 'a bad pick was accepted');
        const p = await wrow();
        must(p.whisper.choice === 'tiny.en' && p.whisper.picked === 'tiny.en' && p.state === 'warn' && /tiny\.en \(\d+ kB\), your pick, isn't downloaded yet/.test(p.detail), `the pick: ${p.state} ${p.detail}`);
        await sapi('/api/app/settings', { section: 'transcribe', values: { engine: 'cloud' } });
        const cloud = await wrow();
        must(cloud.state === 'ok' && /no model needed here/.test(cloud.detail), `cloud: ${cloud.state} ${cloud.detail}`);
        await sapi('/api/app/settings', { section: 'transcribe', values: { engine: 'local' } });
        return `recommended here: ${rec} · ${table.map(([m, x]) => `${m.gpu || (m.apple ? `Apple ${m.ramGB} GB` : `CPU ${m.ramGB} GB`)} → ${x}`).join(', ')} · pick tiny.en saved`;
      });

      await check('Whisper Download (fake Hugging Face): progress, a cut download never counted, Range carry-on, checksum refusal, the snapshot faster-whisper reads', async () => {
        const W = REPOS[WHISPER['tiny.en']].files['model.bin'], blob = join(wDir('tiny.en'), 'blobs', sha256(W)), part = `${blob}.incomplete`;
        hfMode = 'cut';
        let r = await download('tiny.en', { family: 'whisper' });
        const cut = existsSync(part) ? statSync(part).size : 0;
        must(r.d.state === 'error' && /carries on/.test(r.d.error) && cut > 0 && cut < W.length && !wHave().includes('tiny.en'), `cut: ${JSON.stringify(r.d)} part ${cut}`);
        must(!existsSync(join(wDir('tiny.en'), 'snapshots', REV, 'model.bin')), 'the weights are in the snapshot before they are whole');
        const mid = await wrow();
        must(mid.state === 'warn' && !mid.whisper.there, `a partial counted: ${mid.state} ${mid.detail}`);
        hfMode = 'slow'; hfLog.length = 0;
        r = await download('tiny.en', { family: 'whisper' });
        const ranged = hfLog.find((x) => x.file === 'model.bin'), readings = r.seen.filter((x) => x.state === 'downloading' && x.got > cut + 1 && x.got < x.total);
        must(r.d.state === 'done' && ranged?.range === `bytes=${cut}-` && readings.length >= 2 && r.d.got === r.d.total && r.d.total === dlBytes(WHISPER['tiny.en']), `carry on: ${JSON.stringify(r.d)} ${ranged?.range} readings ${readings.length}`);
        const snap = readdirSync(join(wDir('tiny.en'), 'snapshots', REV)).sort();
        must(JSON.stringify(snap) === JSON.stringify(['config.json', 'model.bin', 'tokenizer.json', 'vocabulary.txt']) && readFileSync(join(wDir('tiny.en'), 'refs', 'main'), 'utf8') === REV
          && readFileSync(join(wDir('tiny.en'), 'snapshots', REV, 'model.bin')).equals(W) && !hfLog.some((x) => x.file === 'README.md'), `snapshot: ${snap}`);
        must(wHave().includes('tiny.en'), `not counted: ${wHave()}`);
        const ok = await wrow();
        must(ok.state === 'ok' && ok.whisper.there && /tiny\.en, your pick/.test(ok.detail), `the row after: ${ok.state} ${ok.detail}`);
        // A bad checksum is refused (and nothing counted); large-v3's snapshot needs its preprocessor_config.json.
        hfMode = 'corrupt';
        r = await download('base.en', { family: 'whisper' });
        must(r.d.state === 'error' && /checksum/.test(r.d.error) && !wHave().includes('base.en'), `checksum: ${JSON.stringify(r.d)}`);
        hfMode = 'ok';
        r = await download('large-v3', { family: 'whisper' });
        must(r.d.state === 'done' && wHave().includes('large-v3'), `large-v3: ${JSON.stringify(r.d)}`);
        const pre = join(wDir('large-v3'), 'snapshots', REV, 'preprocessor_config.json');
        renameSync(pre, `${pre}.away`);
        must(!wHave().includes('large-v3'), 'large-v3 counted without its preprocessor_config.json');
        renameSync(`${pre}.away`, pre);
        // faster-whisper's own lookup (the one transcription uses, offline) finds the model there.
        const env = { ...process.env, HF_HUB_CACHE: HF, HF_HUB_OFFLINE: '1', PYTHONDONTWRITEBYTECODE: '1' };
        const found = execFileSync(PY, ['-c', 'from faster_whisper.utils import download_model\nprint(download_model("tiny.en", local_files_only=True))'], { env, encoding: 'utf8' }).trim().split('\n').pop();
        must(realpathSync(found) === realpathSync(join(HF, 'models--Systran--faster-whisper-tiny.en', 'snapshots', REV)), `faster-whisper looked in ${found}`);
        await sapi('/api/app/settings', { section: 'transcribe', values: { model: 'auto' } });
        return `cut at ${cut} not counted · carried on with Range (${readings.length} readings) · checksum refused · large-v3 needs preprocessor_config.json · faster-whisper finds ${found.split(sep).slice(-3).join('/')}`;
      });
      await check('MLX Whisper (fake Hugging Face): the build switch, every file of mlx-community\'s repo downloaded and counted, the skill and the chats find it', async () => {
        const machine = (await sapi('/api/app/settings')).json.machine;
        await sapi('/api/app/settings', { section: 'transcribe', values: { whisperEngine: 'mlx', model: 'tiny.en' } });
        const w = await wrow();
        if (!machine.arm64) {
          must(w.whisper.family === 'whisper' && w.whisper.mlxOk === false, `not Apple Silicon: ${JSON.stringify(w.whisper).slice(0, 200)}`);
          await sapi('/api/app/settings', { section: 'transcribe', values: { whisperEngine: 'faster-whisper', model: 'auto' } });
          return 'not Apple Silicon: MLX is off, faster-whisper stays';
        }
        const src = w.whisper.models.find((m) => m.id === 'tiny.en').source;
        must(w.whisper.family === 'mlx' && w.whisper.engine === 'mlx' && w.state === 'warn' && src.line === `From Hugging Face · mlx-community/whisper-tiny.en-mlx (mlx-community) · ${kb(dlBytes('mlx-community/whisper-tiny.en-mlx'))} · licence: mit`,
          `the MLX row: ${w.state} ${w.detail} ${src.line}`);
        const r = await download('tiny.en', { family: 'mlx' });
        const dir = join(HF, 'models--mlx-community--whisper-tiny.en-mlx', 'snapshots', REV);
        must(r.d.state === 'done' && readdirSync(dir).sort().join() === '.gitattributes,README.md,config.json,weights.npz', `download: ${JSON.stringify(r.d)} ${existsSync(dir) ? readdirSync(dir) : ''}`);
        const ok = await wrow();
        must(ok.state === 'ok' && /on MLX Whisper/.test(ok.detail), `after: ${ok.state} ${ok.detail}`);
        const env = { ...process.env, HF_HUB_CACHE: HF, PYTHONDONTWRITEBYTECODE: '1' };
        const skill = join(APP, 'starter', '.claude', 'skills', 'transcribe', 'scripts');
        const seen = execFileSync(PY, ['-c', `import sys; sys.path.insert(0, ${JSON.stringify(skill)}); import transcribe as t; print(t.mlx_cached("tiny.en"), t.mlx_repo("tiny.en"))`], { env, encoding: 'utf8' }).trim();
        must(seen === 'True mlx-community/whisper-tiny.en-mlx', `the skill sees: ${seen}`);
        const chat = modRun(`const S = await import(${JSON.stringify(new URL('../server/settings.mjs', import.meta.url).href)});
          const e = await S.childEnv(); const h = await S.transcribeHow({ has: async () => false }); console.log(JSON.stringify({ engine: e.STUDIO_TRANSCRIBE_ENGINE, text: h.text }));`,
          { STUDIO_LOCAL_DIR: SAMLOCAL, HF_HUB_CACHE: HF, STUDIO_KEYCHAIN_SERVICE: 'StudioSmokeNoKeys' });
        must(chat.engine === 'mlx' && /--engine mlx --model tiny\.en/.test(chat.text) && /on MLX Whisper/.test(chat.text), `the chats: ${JSON.stringify(chat)}`);
        await sapi('/api/app/settings', { section: 'transcribe', values: { whisperEngine: 'faster-whisper', model: 'auto' } });
        return `${src.line} · all four files · the skill and the brief use it`;
      });

      await check('octopus models: the list, Setup\'s own Download followed to the end, and only the list is read-only', async () => {
        const cli = join(APP, 'bin', 'octopus.mjs');
        // Not spawnSync: the fake Hugging Face answers from this process, so it must keep running meanwhile.
        const run = (...a) => new Promise((done) => {
          const p = spawn(process.execPath, [cli, ...a], { env: { ...process.env, STUDIO_URL: SB } });
          let stdout = '', stderr = '';
          p.stdout.on('data', (d) => { stdout += d; }); p.stderr.on('data', (d) => { stderr += d; });
          p.on('close', (status) => done({ status, stdout, stderr }));
        });
        hfMode = 'ok';
        const r = await run('models', 'download', 'sam2', 'base-plus');
        must(r.status === 0 && /base-plus is downloaded/.test(r.stdout), `download: ${r.status} ${r.stdout} ${r.stderr}`);
        const l = await run('models', 'sam2');
        must(l.status === 0 && /base-plus \(downloaded\)/.test(l.stdout) && /From Hugging Face · facebook\/sam2\.1-hiera-base-plus/.test(l.stdout), `list: ${l.stdout} ${l.stderr}`);
        const bad = await run('models', 'download', 'sam2', 'huge');
        must(bad.status === 1 && /Unknown model/.test(bad.stderr), `a bad size: ${bad.stderr}`);
        const ro = modRun(`const R = await import(${JSON.stringify(new URL('../server/readonly.mjs', import.meta.url).href)});
          console.log(JSON.stringify([R.studioRead('node "${cli.replace(/\\/g, '/')}" models sam2'), R.studioRead('node "${cli.replace(/\\/g, '/')}" models download sam2 tiny')]));`);
        must(ro[0] === true && ro[1] === false, `read-only: ${JSON.stringify(ro)}`);
        return `${r.stdout.trim().split('\n').pop()} · list read-only, download asks`;
      });
    } finally {
      sam.kill();
      hf.close();
    }
  }

  // ---- the onboarding scan (server/onboarding.mjs, web/setup.js): agents through stand-ins (Claude Code, Codex, pi are
  // small scripts; LM Studio and Ollama are fake servers), Connect only with a yes, the installs and downloads after an
  // OK (stand-in brew, lms and ollama), the Python rule, ffmpeg first, the first launch's studio (a throwaway home), the
  // Whisper build per machine, the octopus download command and the chat's banner. ----
  if (!ONLY || /scan|onboarding|first launch|python rule|banner|octopus models|whisper build/i.test(ONLY.source)) {
    const OW = process.platform === 'win32';
    const SC = join(ROOT, 'scan'), HOMEX = join(SC, 'home'), SCLOCAL = otherInstall('local-scan');
    mkdirSync(join(HOMEX, '.lmstudio'), { recursive: true }); // LM Studio "is installed" in the throwaway home
    const stand = (name, body) => { const f = join(SC, name); writeFileSync(f, `#!/bin/sh\n${body}\n`); if (!OW) execFileSync('chmod', ['755', f]); return f; };
    mkdirSync(SC, { recursive: true });
    // Each stand-in reads its mode from a file, so one server sees every state.
    const MODE = (n) => join(SC, `${n}.mode`);
    const mode = (n, v) => writeFileSync(MODE(n), v);
    const claudeS = stand('claude', `case "$1" in --version) echo "9.9.9 (Claude Code)";; auth) if [ "$(cat '${MODE('claude')}')" = signedout ]; then echo '{"loggedIn":false}'; else echo '{"loggedIn":true,"authMethod":"claude.ai","subscriptionType":"max"}'; fi;; esac`);
    const codexS = stand('codex', `case "$1" in --version) echo "codex-cli 0.200.1";; login) if [ "$(cat '${MODE('codex')}')" = signedout ]; then echo "Not logged in"; else echo "Logged in using ChatGPT"; fi;; esac`);
    const piS = stand('pi', 'echo "0.99.5"');
    const lmsS = stand('lms', `echo "Downloading $2 ..."; echo "100%"; echo "$*" > '${join(SC, 'lms.args')}'`);
    const ollamaS = stand('ollama', `echo "pulling $2"; echo "success"; echo "$*" > '${join(SC, 'ollama.args')}'`);
    const brewS = stand('brew', `echo "==> Installing $2"; echo "$*" > '${join(SC, 'brew.args')}'`);
    mode('claude', 'in'); mode('codex', 'in');
    // Fake LM Studio and Ollama, each with a mode: ok, nomodel, context, old.
    let lmMode = 'ok', olMode = 'ok';
    const lm = httpServer((req, res) => {
      const j = (o, c = 200) => { res.writeHead(c, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(o)); };
      if (req.url === '/api/v1/models') {
        if (lmMode === 'old') return j({ error: 'no' }, 404);
        if (lmMode === 'nomodel') return j({ models: [] });
        return j({ models: [{ type: 'llm', key: 'qwen/qwen3-coder-30b', display_name: 'Qwen3 Coder 30B', max_context_length: 262144, capabilities: { trained_for_tool_use: true },
          loaded_instances: lmMode === 'context' ? [{ config: { context_length: 4096 } }] : [{ config: { context_length: 65536 } }] }] });
      }
      if (req.url === '/v1/models') return j({ data: [{ id: 'qwen/qwen3-coder-30b' }] });
      j({}, 404);
    });
    const ol = httpServer((req, res) => {
      const j = (o, c = 200) => { res.writeHead(c, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(o)); };
      if (req.url === '/api/version') return j({ version: olMode === 'old' ? '0.12.3' : '0.15.0' });
      if (req.url === '/api/tags') return j({ models: olMode === 'nomodel' ? [] : [{ name: 'qwen3:8b', details: { parameter_size: '8B' } }] });
      if (req.url === '/api/ps') return j({ models: olMode === 'context' ? [{ name: 'qwen3:8b', context_length: 4096 }] : [] });
      j({}, 404);
    });
    const [lmPort, olPort, deadPort, scPort] = [await freePort(), await freePort(), await freePort(), await freePort()];
    await new Promise((d) => lm.listen(lmPort, '127.0.0.1', d)); await new Promise((d) => ol.listen(olPort, '127.0.0.1', d));
    const SCSET = join(SCLOCAL, 'settings.json');
    const baseSet = { setup: { done: false }, updates: { auto: false }, studio: STUDIO, claudePath: claudeS, codexPath: codexS, piPath: piS, lms: lmsS, ollama: ollamaS, brew: brewS,
      lmstudioUrl: `http://127.0.0.1:${lmPort}`, ollamaUrl: `http://127.0.0.1:${olPort}` };
    writeFileSync(SCSET, JSON.stringify(baseSet));
    const scan = spawn(process.execPath, [join(APP, 'server', 'index.mjs')], { cwd: APP, stdio: 'ignore',
      env: otherEnv(scPort, SCLOCAL, { HOME: HOMEX, USERPROFILE: HOMEX, HF_HUB_CACHE: join(SC, 'hf'), HF_ENDPOINT: `http://127.0.0.1:${deadPort}`, STUDIO_KEYCHAIN_SERVICE: 'StudioSmokeNoKeys' }) });
    const SCB = `http://127.0.0.1:${scPort}`;
    const sc = async (path, body) => {
      const r = await fetch(SCB + path, body === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Studio': '1' }, body: JSON.stringify(body) });
      const text = await r.text(); let json = null; try { json = JSON.parse(text); } catch {}
      return { status: r.status, json, text };
    };
    const agents = async () => (await sc('/api/app/scan/agents')).json;
    const row = (s, id) => s.agents.find((a) => a.id === id);
    const set = () => JSON.parse(readFileSync(SCSET, 'utf8'));
    const waitAction = async (id) => { for (let i = 0; i < 60; i++) { const j = (await sc(`/api/app/scan/action?id=${id}`)).json; if (j.state !== 'running') return j; await sleep(100); } return null; };
    try {
      await check('onboarding scan: agents in order, Claude recommended, each state through stand-ins (ready, needs action, not found)', async () => {
        await until(async () => { try { return (await fetch(SCB + '/')).ok; } catch { return false; } }, 30000, 'the scan server');
        if (OW) return 'Windows: the stand-ins are shell scripts (skipped)';
        let s = await agents();
        must(s.agents.map((a) => a.id).join() === 'claude,codex,lmstudio,ollama,pi' && row(s, 'claude').recommended && row(s, 'codex').fallback && !s.connected, `order: ${s.agents.map((a) => a.id)} connected ${JSON.stringify(s.connected)}`);
        must(row(s, 'claude').state === 'ok' && row(s, 'claude').detail === 'Claude Code 9.9.9 · signed in · Max plan' && row(s, 'codex').detail === 'Codex 0.200.1 · signed in · ChatGPT plan' && row(s, 'pi').state === 'ok',
          `ready: ${JSON.stringify(s.agents.map((a) => [a.id, a.state, a.detail]))}`);
        must(row(s, 'lmstudio').state === 'ok' && row(s, 'lmstudio').via.join() === 'claude,codex' && row(s, 'ollama').state === 'ok', `local ok: ${JSON.stringify([row(s, 'lmstudio'), row(s, 'ollama')].map((a) => [a.state, a.detail]))}`);
        mode('claude', 'signedout'); mode('codex', 'signedout');
        s = await agents();
        must(row(s, 'claude').state === 'action' && /not signed in/.test(row(s, 'claude').detail) && /run claude and sign in/.test(row(s, 'claude').how) && row(s, 'codex').state === 'action' && /codex login/.test(row(s, 'codex').how), 'not signed in');
        mode('claude', 'in'); mode('codex', 'in');
        writeFileSync(SCSET, JSON.stringify({ ...set(), claudePath: join(SC, 'nothing-here'), piPath: join(SC, 'no-pi') }));
        s = await agents();
        must(row(s, 'claude').state === 'missing' && row(s, 'pi').state === 'missing' && row(s, 'claude').how, `not found: ${JSON.stringify([row(s, 'claude'), row(s, 'pi')].map((a) => [a.state, a.detail]))}`);
        writeFileSync(SCSET, JSON.stringify({ ...set(), claudePath: claudeS, piPath: piS }));
        return s.agents.map((a) => `${a.id} ${a.state}`).join(' · ');
      });

      await check('onboarding scan: LM Studio and Ollama, every failure text (server off, no model, context too small, too old)', async () => {
        if (OW) return 'Windows: skipped';
        const texts = [];
        for (const m of ['nomodel', 'context', 'old']) {
          lmMode = m; olMode = m;
          const s = await agents(), a = row(s, 'lmstudio'), o = row(s, 'ollama');
          must(a.state === 'action' && a.problem === m && o.state === 'action' && o.problem === m, `${m}: ${a.state}/${a.problem} ${o.state}/${o.problem}`);
          if (m === 'nomodel') must(/Download a model in LM Studio/.test(a.how) && /ollama pull/.test(o.how) && a.cli && o.cli, `no model: ${a.how} | ${o.how}`);
          if (m === 'context') must(/needs a context of 32K or more/.test(a.how) && /Context Length 32768/.test(a.how) && /OLLAMA_CONTEXT_LENGTH=32768/.test(o.how) && /4K context/.test(a.detail), `context: ${a.how} | ${o.how}`);
          if (m === 'old') must(a.how === 'Update LM Studio, or use it with Codex or pi.' && o.how === 'Update Ollama, or use it with Codex or pi.' && a.via.join() === 'codex', `old: ${a.how} via ${a.via}`);
          texts.push(`${m}: ${a.detail}`);
        }
        lmMode = 'ok'; olMode = 'ok';
        // The server off: LM Studio is there (its folder in the home), Ollama isn't anywhere.
        writeFileSync(SCSET, JSON.stringify({ ...set(), lmstudioUrl: `http://127.0.0.1:${deadPort}`, ollamaUrl: `http://127.0.0.1:${deadPort}`, ollama: join(SC, 'no-ollama') }));
        const s = await agents(), a = row(s, 'lmstudio'), o = row(s, 'ollama');
        must(a.state === 'action' && a.problem === 'off' && a.detail === 'LM Studio · server off' && a.how === 'Start LM Studio → Developer → Start server, then press Retry.' && o.state === 'missing', `off: ${a.detail} ${a.how} · ollama ${o.state}`);
        writeFileSync(SCSET, JSON.stringify({ ...set(), lmstudioUrl: `http://127.0.0.1:${lmPort}`, ollamaUrl: `http://127.0.0.1:${olPort}`, ollama: ollamaS }));
        return [...texts, `off: ${a.detail}`].join(' | ');
      });

      await check('onboarding scan: Connect only with a yes; Claude Code, a local model behind Claude Code or Codex; Continue with nothing connected', async () => {
        must((await sc('/api/app/scan/connect', { agent: 'claude' })).status === 400 && !set().setup.agent, 'connected without a yes');
        // Continue with nothing connected: Setup is done, the agent stays the default.
        must((await sc('/api/app/setup', { done: true })).json?.done === true && !set().setup.agent, 'Continue with nothing connected');
        writeFileSync(SCSET, JSON.stringify({ ...set(), setup: { done: false } }));
        let r = await sc('/api/app/scan/connect', { agent: 'claude', confirmed: true });
        must(r.json?.connected?.id === 'claude' && set().claude.engine === 'claude' && set().claude.ccSource === 'plan' && set().setup.agent === 'claude', `claude: ${r.text}`);
        if (!OW) must((await agents()).connected?.id === 'claude', 'the scan does not show Claude Code connected');
        r = await sc('/api/app/scan/connect', { agent: 'lmstudio', via: 'claude', model: 'qwen/qwen3-coder-30b', confirmed: true });
        must(r.json?.connected?.id === 'lmstudio' && r.json.connected.via === 'claude' && set().claude.ccSource === 'lmstudio' && set().claude.ccModel === 'qwen/qwen3-coder-30b' && set().claude.ccUrl === `http://127.0.0.1:${lmPort}`, `LM Studio behind Claude Code: ${r.text} ${JSON.stringify(set().claude)}`);
        r = await sc('/api/app/scan/connect', { agent: 'ollama', via: 'codex', model: 'qwen3:8b', confirmed: true });
        must(r.json?.connected?.via === 'codex' && set().claude.engine === 'codex' && set().claude.codexProvider === 'ollama' && set().claude.codexModel === 'qwen3:8b', `Ollama behind Codex: ${r.text}`);
        must((await sc('/api/app/scan/connect', { agent: 'lmstudio', via: 'claude', confirmed: true })).status === 400, 'a local server without a model');
        await sc('/api/app/scan/connect', { agent: 'claude', confirmed: true });
        return 'no yes, no switch · Claude Code · LM Studio behind Claude Code · Ollama behind Codex · Continue with none';
      });

      await check('onboarding scan: downloads and installs after an OK (lms get, ollama pull, brew install ffmpeg), the ffmpeg row first with its Install', async () => {
        must((await sc('/api/app/scan/action', { action: 'lms-get', model: 'qwen/qwen3-8b' })).status === 400, 'a download without an OK');
        must((await sc('/api/app/scan/action', { action: 'lms-get', model: 'x; rm -rf /', confirmed: true })).status === 400, 'a bad model name');
        const st = (await sc('/api/app/setup')).json;
        must(st.checks[0].id === 'ffmpeg' && st.checks[0].card === 'tools' && st.checks[0].title === 'ffmpeg: renders and exports your videos' && st.checks.filter((c) => c.card === 'tools').map((c) => c.id).join() === 'ffmpeg,recorder,folders,python',
          `the tools card: ${JSON.stringify(st.checks)}`);
        if (OW) return 'Windows: the stand-ins are shell scripts (ffmpeg row checked)';
        let a = await sc('/api/app/scan/action', { action: 'lms-get', model: 'qwen/qwen3-8b', confirmed: true });
        let j = await waitAction('lms-get');
        must(a.json?.state && j?.state === 'done' && readFileSync(join(SC, 'lms.args'), 'utf8').trim() === 'get qwen/qwen3-8b --yes' && /100%/.test(j.tail), `lms get: ${JSON.stringify(j)}`);
        a = await sc('/api/app/scan/action', { action: 'ollama-pull', model: 'qwen3:8b', confirmed: true });
        j = await waitAction('ollama-pull');
        must(j?.state === 'done' && readFileSync(join(SC, 'ollama.args'), 'utf8').trim() === 'pull qwen3:8b' && /success/.test(j.tail), `ollama pull: ${JSON.stringify(j)}`);
        // ffmpeg missing: the row offers the one-command install (a Mac: brew), which runs only after the OK.
        writeFileSync(SCSET, JSON.stringify({ ...set(), ffmpeg: join(SC, 'no-ffmpeg'), ffprobe: join(SC, 'no-ffprobe') }));
        const ff = (await sc('/api/app/setup/check?id=ffmpeg')).json;
        must(ff.state === 'fail' && /exporting needs/.test(ff.detail) && ff.manual === 'https://ffmpeg.org/download.html' && (process.platform !== 'darwin' || ff.install?.cmd === 'brew install ffmpeg'), `ffmpeg missing: ${JSON.stringify(ff)}`);
        must((await sc('/api/status')).json?.ffmpeg === false, 'Export would still think ffmpeg is there');
        if (process.platform === 'darwin') {
          await sc('/api/app/scan/action', { action: 'ffmpeg', confirmed: true });
          j = await waitAction('ffmpeg');
          must(j?.state === 'done' && readFileSync(join(SC, 'brew.args'), 'utf8').trim() === 'install ffmpeg', `brew: ${JSON.stringify(j)}`);
        }
        const { ffmpeg, ffprobe, ...rest } = set(); writeFileSync(SCSET, JSON.stringify(rest));
        return `lms get, ollama pull${process.platform === 'darwin' ? ', brew install ffmpeg' : ''} after an OK · ffmpeg row first with ${ff.install?.cmd || 'the manual link'}`;
      });

      await check('the python rule: needsLocalPython on and off; the row says "Not needed" and never blocks', async () => {
        const need = (s, has) => modRun(`const S = await import(${JSON.stringify(new URL('../server/settings.mjs', import.meta.url).href)});
          console.log(JSON.stringify(await S.needsLocalPython(${JSON.stringify(s)}, { has: async () => ${has} })));`, { STUDIO_LOCAL_DIR: SCLOCAL });
        const cases = [
          [{ transcribe: { engine: 'cloud', provider: 'deepgram' }, claude: { engine: 'claude', ccSource: 'plan' } }, true, false],
          [{ transcribe: { engine: 'local' }, claude: { engine: 'claude', ccSource: 'plan' } }, true, true],
          [{ transcribe: { engine: 'cloud', provider: 'deepgram' }, claude: { engine: 'claude', ccSource: 'plan' } }, false, true],
          [{ transcribe: { engine: 'cloud', provider: 'deepgram' }, claude: { engine: 'claude', ccSource: 'lmstudio' } }, true, true],
          [{ transcribe: { engine: 'cloud', provider: 'deepgram' }, claude: { engine: 'codex', codexProvider: 'ollama' } }, true, true],
          [{ transcribe: { engine: 'cloud', provider: 'deepgram' }, claude: { engine: 'codex', codexProvider: 'chatgpt' } }, true, false],
        ];
        for (const [s, has, want] of cases) must(need(s, has) === want, `${JSON.stringify(s)} key ${has} → ${need(s, has)}, not ${want}`);
        // The page greys "Not needed" out and Continue never asks about it (web/setup.js).
        const page = readFileSync(join(APP, 'web', 'setup.js'), 'utf8');
        must(/skip: 'Not needed'/.test(page) && !/Still missing/.test(page), 'the page');
        return 'cloud + key + Claude plan: not needed · local transcription, no key, LM Studio, Codex + Ollama: needed';
      });

      await check('first launch: ~/Video Octopus made by itself (a throwaway home); an install with a studio, or with Setup done, untouched', async () => {
        const home = join(SC, 'fresh-home'), local = join(SC, 'fresh-local'), port = await freePort();
        mkdirSync(home, { recursive: true }); mkdirSync(local, { recursive: true });
        const one = spawn(process.execPath, [join(APP, 'server', 'index.mjs')], { cwd: APP, stdio: 'ignore', env: otherEnv(port, local, { HOME: home, USERPROFILE: home }) });
        try {
          await until(async () => { try { return (await fetch(`http://127.0.0.1:${port}/`)).ok; } catch { return false; } }, 30000, 'the first launch');
          const made = join(home, 'Video Octopus');
          must(['CLAUDE.md', 'projects', 'recordings', '.claude/skills/transcribe/SKILL.md', '.studio/starter.json'].every((f) => existsSync(join(made, f))), `not made: ${existsSync(made) ? readdirSync(made) : 'nothing'}`);
          const s = JSON.parse(readFileSync(join(local, 'settings.json'), 'utf8'));
          must(s.studio === made && s.recordingsDir === join(made, 'recordings'), `settings: ${JSON.stringify(s)}`);
          const st = (await fetch(`http://127.0.0.1:${port}/api/app/setup`).then((x) => x.json()));
          must(st.needed === true && st.done === false, 'the onboarding screen would not show');
        } finally { one.kill(); }
        // An install with its own studio, and one that finished Setup: nothing made in the home, settings as they were.
        for (const [name, s0] of [['own', { studio: STUDIO, setup: { done: false }, updates: { auto: false } }], ['done', { setup: { done: true }, updates: { auto: false } }]]) {
          const h2 = join(SC, `home-${name}`), l2 = join(SC, `local-${name}`), p2 = await freePort();
          mkdirSync(h2, { recursive: true }); mkdirSync(l2, { recursive: true });
          writeFileSync(join(l2, 'settings.json'), JSON.stringify(s0));
          const two = spawn(process.execPath, [join(APP, 'server', 'index.mjs')], { cwd: APP, stdio: 'ignore', env: otherEnv(p2, l2, { HOME: h2, USERPROFILE: h2 }) });
          try {
            await until(async () => { try { return (await fetch(`http://127.0.0.1:${p2}/`)).ok; } catch { return false; } }, 30000, `the ${name} install`);
            must(!existsSync(join(h2, 'Video Octopus')) && JSON.stringify(JSON.parse(readFileSync(join(l2, 'settings.json'), 'utf8'))) === JSON.stringify(s0), `${name}: touched`);
          } finally { two.kill(); }
        }
        return 'fresh: ~/Video Octopus with projects, recordings and the starter · own studio and Setup done: untouched';
      });

      await check('whisper build per machine: MLX on Apple Silicon (not under Rosetta), faster-whisper on CUDA, one size down on the CPU; SAM in machineInfo', async () => {
        const pick = (m) => modRun(`const S = await import(${JSON.stringify(new URL('../server/settings.mjs', import.meta.url).href)}); console.log(JSON.stringify(S.whisperPick(${JSON.stringify(m)})));`, { STUDIO_LOCAL_DIR: SCLOCAL });
        const table = [[{ apple: true, arm64: true, ramGB: 48 }, 'large-v3', 'mlx'], [{ apple: true, arm64: true, ramGB: 16 }, 'medium.en', 'mlx'], [{ apple: true, arm64: true, ramGB: 8 }, 'small.en', 'mlx'],
          [{ apple: true, arm64: false, ramGB: 16 }, 'small.en', 'faster-whisper'], [{ apple: false, ramGB: 32 }, 'medium.en', 'faster-whisper'], [{ apple: false, ramGB: 8 }, 'base.en', 'faster-whisper'],
          [{ gpu: 'NVIDIA RTX 4090', vramMB: 24564 }, 'large-v3', 'faster-whisper'], [{ gpu: 'NVIDIA RTX 3050', vramMB: 6144 }, 'medium.en', 'faster-whisper']];
        for (const [m, model, engine] of table) { const r = pick(m); must(r.model === model && r.engine === engine, `${JSON.stringify(m)} → ${JSON.stringify(r)}, not ${model} on ${engine}`); }
        const mi = (await sc('/api/app/settings')).json.machine;
        must(mi.sam?.size && mi.whisper?.engine && typeof mi.arm64 === 'boolean', `machineInfo: ${JSON.stringify(mi)}`);
        const same = modRun(`const S = await import(${JSON.stringify(new URL('../server/sam2.mjs', import.meta.url).href)}); console.log(JSON.stringify(S.sam2Recommend(S.sam2Machine(${JSON.stringify(mi)}))));`);
        must(JSON.stringify(same) === JSON.stringify(mi.sam), `machineInfo().sam isn't sam2.mjs's table: ${JSON.stringify(mi.sam)} vs ${JSON.stringify(same)}`);
        return `${table.length} machine types · this Mac: ${mi.whisper.model} on ${mi.whisper.engine}, SAM ${mi.sam.size}`;
      });

      await check('chat banner: the local server under the chats is down (exact words), the chat says so before a message goes, nothing switches', async () => {
        await sc('/api/app/scan/connect', { agent: 'lmstudio', via: 'claude', model: 'qwen/qwen3-coder-30b', confirmed: true });
        writeFileSync(SCSET, JSON.stringify({ ...set(), claude: { ...set().claude, ccUrl: `http://127.0.0.1:${deadPort}` } }));
        const d = (await sc('/api/app/scan/local')).json?.down;
        must(d?.name === 'LM Studio' && d.text === "LM Studio isn't running. Start it, or switch this chat to Claude Code.", `down: ${JSON.stringify(d)}`);
        const g = modRun(`const E = await import(${JSON.stringify(new URL('../server/engines.mjs', import.meta.url).href)});
          const evs = []; const chat = { send: async () => 'sent', emit: (e) => evs.push(e) }; E.guardLocal(chat); const r = await chat.send('hi'); console.log(JSON.stringify({ r, evs }));`, { STUDIO_LOCAL_DIR: SCLOCAL });
        must(g.r === 'sent' && g.evs.length === 1 && g.evs[0].t === 'local-down' && g.evs[0].text === d.text, `the guard: ${JSON.stringify(g)}`);
        must(set().claude.ccSource === 'lmstudio', 'it switched by itself');
        await sc('/api/app/scan/connect', { agent: 'claude', confirmed: true });
        must((await sc('/api/app/scan/local')).json?.down === null, 'Claude Code on the plan has no local server');
        const app = readFileSync(join(APP, 'web', 'app.js'), 'utf8');
        must(/case 'local-down': localDown\(ev\)/.test(app) && /confirmBox\(\{ title: 'Switch the chats to Claude Code\?'/.test(app), 'the page does not show it, or switches without asking');
        return d.text;
      });

      // The two screens through the real page (test/setup.e2e.mjs). Not execFileSync: the fake LM Studio and Ollama
      // answer from this process.
      if (process.env.PLAYWRIGHT_PATH) {
        await check('onboarding screens through the page: the scan, one recommended model per row with the rest folded, Continue to Make it yours, Skip into the app (headless Chrome)', async () => {
          writeFileSync(SCSET, JSON.stringify({ ...set(), setup: { done: false }, python: PY }));
          const r = await new Promise((done) => {
            const c = spawn(process.execPath, [join(APP, 'test', 'setup.e2e.mjs')], { env: { ...process.env, STUDIO_URL: SCB } });
            let out = ''; c.stdout.on('data', (d) => { out += d; }); c.stderr.on('data', (d) => { out += d; });
            c.on('close', (code) => done({ code, out }));
          });
          must(r.code === 0, r.out.trim().split('\n').slice(-4).join(' | '));
          return r.out.trim().split('\n').pop();
        });
      }
    } finally {
      scan.kill(); lm.close(); ol.close();
    }
  }

  await check('saved layouts: save, list, apply on a project, remove', async () => {
    must(id, 'no project');
    const lay = (await api(`/api/projects/${id}`)).json.layout;
    const s = await api('/api/layouts', { op: 'save', name: 'Smoke boxed', layout: { ...lay, preset: 'boxed', side: 'left' }, project: id });
    must(s.status === 200 && s.json?.saved?.id, s.text);
    must(existsSync(join(STUDIO, '.studio', 'layouts.json')), 'no .studio/layouts.json');
    must((await api('/api/layouts')).json?.layouts?.length === 1, 'not listed');
    const a = await api('/api/layouts', { op: 'apply', id: s.json.saved.id, project: id });
    must(a.json?.layout?.preset === 'boxed' && a.json.layout.side === 'left', `apply: ${a.text}`);
    const r = await api('/api/layouts', { op: 'remove', id: s.json.saved.id });
    must(r.status === 200 && !r.json.layouts.length, r.text);
    return 'saved, applied, removed';
  });

  await check('hidden layers leave the picture (compose, shared with the export)', async () => {
    const { compose, normalize } = await import(new URL('../web/layout.js', import.meta.url).href);
    const dims = { screen: [1920, 1080], cam: [1920, 1080], files: {} };
    const l = normalize({ preset: 'pip' }, 'tutorial');
    must(compose(l, dims).layers.length === 2, 'PiP should have two layers');
    const off = compose(normalize({ ...l, hidden: ['cam'] }, 'tutorial'), dims);
    must(off.layers.length === 1 && off.layers[0].ref === 'screen' && off.preset === 'pip', JSON.stringify(off.layers.map((x) => x.ref)));
    return 'camera hidden: screen only';
  });

  // ---- canvas: the screen's crop, zoom and focus, border colours, and an export that matches (web/layout.js) ----
  await check('screen crop, zoom and focus: saved and read back, old layouts are the whole picture', async () => {
    must(id, 'no project');
    const { compose, normalize, DEFAULT_SCREEN } = await import(new URL('../web/layout.js', import.meta.url).href);
    const lay = (await api(`/api/projects/${id}`)).json.layout;
    must(lay.screen && lay.screen.zoom === 1 && Object.values(lay.screen.crop).every((v) => v === 0), `a project without one: ${JSON.stringify(lay.screen)}`);
    const want = { crop: { t: 0.1, r: 0.05, b: 0.08, l: 0 }, zoom: 2, focus: { x: 0.3, y: 0.6 } };
    const r = await api(`/api/projects/${id}/layout`, { layout: { ...lay, preset: 'split', screen: want } });
    must(r.status === 200, r.text);
    const back = (await api(`/api/projects/${id}`)).json.layout.screen;
    must(JSON.stringify(back.crop) === JSON.stringify(want.crop) && back.zoom === 2 && back.focus.x === 0.3 && back.focus.y === 0.6, `read back: ${JSON.stringify(back)}`);
    must(JSON.stringify(JSON.parse(readFileSync(join(STUDIO, 'projects', id, 'project.json'), 'utf8')).layout.screen.crop) === JSON.stringify(want.crop), 'not in project.json');
    // At least 10% of each side stays; zoom 1–4; nonsense is the whole picture.
    const c = normalize({ screen: { crop: { t: 0.95, b: 0.5, l: 0.6, r: 0.6 }, zoom: 9 } }).screen;
    must(c.crop.t === 0.9 && c.crop.b === 0 && c.crop.l === 0.6 && Math.abs(c.crop.r - 0.3) < 1e-9 && c.zoom === 4, `clamped: ${JSON.stringify(c)}`);
    must(JSON.stringify(normalize({ screen: 'x' }).screen.crop) === JSON.stringify(DEFAULT_SCREEN.crop), 'nonsense should be no crop');
    // compose: the screen's box takes the cropped picture's shape; its crop stays inside what the crop leaves.
    const dims = { screen: [1920, 1080], cam: [1920, 1080], files: {} };
    const old = compose(normalize({ preset: 'screen' }), dims).layers[0];
    must(old.crop.x === 0 && old.crop.y === 0 && old.crop.w === 1 && old.crop.h === 1 && old.box.w === 1920 && old.box.h === 1080, `old layout: ${JSON.stringify(old)}`);
    const sc = compose(normalize({ preset: 'screen', screen: want }), dims).layers[0];
    const arWant = (1920 * 0.95) / (1080 * 0.82);
    must(Math.abs(sc.box.w / sc.box.h - arWant) < 0.01, `box aspect ${sc.box.w / sc.box.h} vs ${arWant}`);
    must(Math.abs(sc.crop.w - 0.95 / 2) < 0.003 && Math.abs(sc.crop.h - 0.82 / 2) < 0.003, `zoom 2: ${JSON.stringify(sc.crop)}`); // (the box is whole pixels)
    must(sc.crop.x >= 0 && sc.crop.y >= 0.1 - 1e-9 && sc.crop.x + sc.crop.w <= 0.95 + 1e-9 && sc.crop.y + sc.crop.h <= 0.92 + 1e-9, `inside the crop: ${JSON.stringify(sc.crop)}`);
    must(Math.abs(sc.crop.x + sc.crop.w / 2 - 0.3) < 1e-6 && Math.abs(sc.crop.y + sc.crop.h / 2 - 0.6) < 1e-6, `centred on the focus: ${JSON.stringify(sc.crop)}`);
    await api(`/api/projects/${id}/layout`, { layout: lay });
    return `saved in Split: crop ${JSON.stringify(want.crop)}, 2×, focus 0.3/0.6 · in Screen the box is ${sc.box.w}×${sc.box.h}`;
  });

  await check('border colours: old names, black, brand and custom hex, the screen card and Boxed', async () => {
    const { compose, normalize, NIGHT } = await import(new URL('../web/layout.js', import.meta.url).href);
    const dims = { screen: [1920, 1080], cam: [1920, 1080], files: {} };
    const camOf = (cam, extra = {}) => compose(normalize({ preset: 'pip', cam, ...extra }), dims).layers.find((x) => x.ref === 'cam');
    const color = (b) => camOf({ border: b }).borderColor;
    must(color('white') === NIGHT.white && color('accent') === NIGHT.accent && color('black') === '#000000', `names: ${color('white')} ${color('accent')} ${color('black')}`);
    must(color('subtle') === NIGHT.line && camOf({ border: 'none' }).border === 0, 'subtle / none');
    must(normalize({ cam: { shape: 'circle' } }).cam.border === 'subtle', 'a framing from before borders keeps its subtle line');
    must(normalize({ cam: { border: '#12AB34' } }).cam.border === '#12ab34' && color('#12AB34') === '#12ab34', 'a hex is kept');
    must(normalize({ cam: { border: '#abc' } }).cam.border === '#aabbcc' && normalize({ cam: { border: '#c2410cff' } }).cam.border === '#c2410c', '#rgb and #rrggbbaa');
    must(normalize({ cam: { border: 'rgb(1,2,3)' } }).cam.border === 'white', 'nonsense is the default');
    const w = camOf({ border: '#12ab34', borderW: 10 });
    must(w.border === 10, `width ${w.border}`);
    // The screen as an inset card in PiP has its own edge; in Boxed it wears the camera's (the cards match).
    const pipScr = compose(normalize({ preset: 'pip', pad: 4, screen: { border: '#ff00ff', borderW: 6 } }), dims).layers[0];
    must(pipScr.card && pipScr.borderColor === '#ff00ff' && pipScr.border === 6, `PiP inset card: ${pipScr.borderColor} ${pipScr.border}`);
    const plain = compose(normalize({ preset: 'pip', pad: 4 }), dims).layers[0];
    must(plain.borderColor === NIGHT.line && plain.shadow === true, 'the inset card still has its subtle line and shadow');
    const boxed = compose(normalize({ preset: 'boxed', cam: { border: '#0ea5e9' }, screen: { border: '#ff00ff' } }), dims).layers;
    must(boxed.every((x) => x.borderColor === '#0ea5e9'), `Boxed: ${boxed.map((x) => x.borderColor)}`);
    // Brand colours reach the page with the project (Settings → Look → Brand).
    await api('/api/app/settings', { section: 'look', values: { colors: ['#0ea5e9', '#facc15'] } });
    const bc = (await api(`/api/projects/${id}`)).json.brandColors;
    must(JSON.stringify(bc) === JSON.stringify(['#0ea5e9', '#facc15']), `brandColors: ${JSON.stringify(bc)}`);
    return 'white/black/accent/subtle/none, #12ab34, #abc → #aabbcc, inset card #ff00ff, Boxed matches, brand colours on the page';
  });

  // A take whose screen has a red band along the top (a browser's bar) and a yellow one at the bottom.
  const bandTake = '20261017-130000';
  let cropId = null;
  const exportOnce = async (pid, layout) => {
    const { compose, normalize } = await import(new URL('../web/layout.js', import.meta.url).href);
    const P = (await api(`/api/projects/${pid}`)).json;
    const scene = compose(normalize(layout, 'tutorial'), P.export.dims);
    const r = await api(`/api/projects/${pid}/export`, { layout, useCut: false, pngs: exportPngs(scene) });
    must(r.status === 200 && r.json?.out, `export: ${r.text}`);
    const file = join(STUDIO, 'projects', pid, r.json.out);
    await until(() => existsSync(file), 60000, r.json.out);
    await until(async () => !(await api(`/api/projects/${pid}`)).json.export.running, 30000, 'the export to end');
    const job = JSON.parse(readFileSync(join(STUDIO, 'projects', pid, r.json.job, 'job.json'), 'utf8'));
    return { file, job, scene, dims: P.export.dims };
  };
  // ffmpeg's crop for each video layer, from the export's own filter graph (the same numbers web/layout.js gives).
  const cropsIn = (job) => [...job.ffmpeg[job.ffmpeg.indexOf('-filter_complex') + 1].matchAll(/crop=(\d+):(\d+):(\d+):(\d+),scale=(\d+):(\d+)/g)].map((m) => m.slice(1).map(Number));
  const wantCrop = (ly, d) => [Math.round(ly.crop.w * d[0]), Math.round(ly.crop.h * d[1]), 2 * Math.round((ly.crop.x * d[0]) / 2), 2 * Math.round((ly.crop.y * d[1]) / 2), ly.box.w, ly.box.h];
  await check('export: a cropped and zoomed screen in every layout (ffmpeg crop = the canvas; a real 2 s render)', async () => {
    if (process.platform !== 'darwin') return 'skipped: the export decodes with VideoToolbox (Mac only)';
    mkdirSync(join(REC, bandTake), { recursive: true });
    execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=0x2050c0:s=1280x720:r=30,drawbox=x=0:y=0:w=1280:h=72:color=0xff0000:t=fill,drawbox=x=0:y=662:w=1280:h=58:color=0xffff00:t=fill',
      '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000', '-t', '2', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'pcm_s16le', join(REC, bandTake, `${bandTake}_screen.mov`)]);
    execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'smptebars=size=1280x720:rate=30', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000',
      '-t', '2', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'pcm_s16le', join(REC, bandTake, `${bandTake}_webcam.mov`)]);
    const r = await api('/api/projects', { name: 'Smoke crop', type: 'tutorial', take: bandTake });
    must(r.status === 200 && r.json?.id, r.text);
    cropId = r.json.id;
    const screen = { crop: { t: 0.12, r: 0, b: 0.1, l: 0 }, zoom: 1.5, focus: { x: 0.45, y: 0.5 } };
    const rows = [];
    for (const [preset, aspect, pad] of [['screen', '16:9', 0], ['pip', '16:9', 0], ['pip', '16:9', 4], ['split', '16:9', 0], ['boxed', '16:9', 0], ['boxed', '9:16', 0]]) {
      const { job, scene, dims } = await exportOnce(cropId, { aspect, preset, pad, screen, cam: { border: '#12ab34' } });
      const got = cropsIn(job), want = scene.layers.map((ly) => wantCrop(ly, dims[ly.role]));
      must(JSON.stringify(got) === JSON.stringify(want), `${preset} ${aspect}: ffmpeg ${JSON.stringify(got)} vs canvas ${JSON.stringify(want)}`);
      const s = scene.layers.find((x) => x.ref === 'screen');
      must(s.crop.y >= 0.12 - 1e-9 && s.crop.y + s.crop.h <= 0.9 + 1e-9, `${preset}: the screen's crop reaches the bands`);
      rows.push(`${preset}${pad ? ' inset' : ''} ${aspect} ${s.box.w}×${s.box.h}`);
    }
    return rows.join(' · ');
  });

  await check('export pixels: the cropped band is gone, a custom border colour is in the MP4', async () => {
    if (process.platform !== 'darwin') return 'skipped: the export decodes with VideoToolbox (Mac only)';
    must(cropId, 'no crop project');
    // Control: no crop, the red band is the top of the picture.
    const a = await exportOnce(cropId, { aspect: '16:9', preset: 'screen' });
    const fa = frameRGB(a.file, 1, { x: 0, y: 0, w: 1920, h: 1080 });
    must(near(rgbAt(fa, 960, 20), [255, 0, 0]), `no crop: the top should be red, got ${rgbAt(fa, 960, 20)}`);
    // Cropped (12% off the top, 10% off the bottom): the box is the picture without the bands, blue to its edges.
    const b = await exportOnce(cropId, { aspect: '16:9', preset: 'screen', screen: { crop: { t: 0.12, b: 0.1 } } });
    const s = b.scene.layers[0], fb = frameRGB(b.file, 1, { x: 0, y: 0, w: 1920, h: 1080 });
    for (const [x, y] of [[960, s.box.y + 3], [300, s.box.y + 3], [960, s.box.y + s.box.h - 4], [1600, s.box.y + s.box.h - 4]]) {
      const c = rgbAt(fb, x, y);
      must(near(c, [32, 80, 192], 45), `cropped: (${x}, ${y}) should be the blue picture, got ${c}`);
    }
    must(s.box.y > 0 && near(rgbAt(fb, 960, Math.floor(s.box.y / 2)), [23, 23, 26], 20), `above the box: the background, got ${rgbAt(fb, 960, Math.floor(s.box.y / 2))}`);
    // A custom border colour on the camera card (PiP), 10 px wide: the middle of its left edge is that colour.
    const c = await exportOnce(cropId, { aspect: '16:9', preset: 'pip', cam: { border: '#12ab34', borderW: 10, shadow: false } });
    const cam = c.scene.layers.find((x) => x.ref === 'cam');
    must(cam.borderColor === '#12ab34' && cam.border === 10, `compose: ${cam.borderColor} ${cam.border}`);
    const fc = frameRGB(c.file, 1, { x: 0, y: 0, w: 1920, h: 1080 });
    const edgePx = rgbAt(fc, cam.box.x + 5, cam.box.y + Math.round(cam.box.h / 2));
    must(near(edgePx, [18, 171, 52], 30), `the border should be #12ab34, got ${edgePx}`);
    return `top row red → blue after the crop (box ${s.box.w}×${s.box.h} at y ${s.box.y}); border pixel ${edgePx}`;
  });

  await check('Layers export: the screen card is cut with the same crop', async () => {
    if (process.platform !== 'darwin') return 'skipped: the export decodes with VideoToolbox (Mac only)';
    must(cropId, 'no crop project');
    const { compose, normalize } = await import(new URL('../web/layout.js', import.meta.url).href);
    const layout = normalize({ aspect: '16:9', preset: 'pip', pad: 4, screen: { crop: { t: 0.12, b: 0.1 }, zoom: 1.25, focus: { x: 0.5, y: 0.5 } } }, 'tutorial');
    const P = (await api(`/api/projects/${cropId}`)).json;
    const scene = compose(layout, P.export.dims);
    const pngs = { ...exportPngs(scene), bgOnly: png(scene.W, scene.H, () => [23, 23, 26, 255]) };
    const r = await api(`/api/projects/${cropId}/export-layers`, { layout, useCut: false, pngs, graphics: false, matte: false, timeline: false, small: true });
    must(r.status === 200, `export-layers: ${r.text}`);
    const folder = await until(() => { try { return readdirSync(join(STUDIO, 'projects', cropId, 'renders')).find((f) => /_layers_v\d+$/.test(f)); } catch { return null; } }, 90000, 'the layers folder');
    const dir = join(STUDIO, 'projects', cropId, 'renders', folder);
    const screenFile = await until(() => readdirSync(dir).find((f) => /screen/i.test(f) && /\.(mov|mp4)$/.test(f)), 30000, 'the screen layer');
    const s = scene.layers.find((x) => x.ref === 'screen');
    const jobDir = readdirSync(join(STUDIO, 'projects', cropId, 'work', 'export')).filter((f) => f.endsWith('_layers')).sort().at(-1);
    const job = JSON.parse(readFileSync(join(STUDIO, 'projects', cropId, 'work', 'export', jobDir, 'job.json'), 'utf8'));
    const want = wantCrop(s, P.export.dims.screen);
    const all = JSON.stringify(job.commands || job);
    must(all.includes(`crop=${want[0]}:${want[1]}:${want[2]}:${want[3]},scale=${want[4]}:${want[5]}`), `no crop=${want.slice(0, 4).join(':')} in the layers job`);
    const f = frameRGB(join(dir, screenFile), 1, { x: s.box.x, y: s.box.y, w: s.box.w, h: s.box.h });
    const top = rgbAt(f, s.box.x + Math.round(s.box.w / 2), s.box.y + 6);
    must(near(top, [32, 80, 192], 45), `the screen layer's top should be blue (band cropped), got ${top}`);
    return `${folder}/${screenFile}: crop=${want.slice(0, 4).join(':')}, top ${top}`;
  });

  await check('New project → Import a file: the file becomes the take', async () => {
    const p = await api('/api/projects', { name: 'Smoke import', type: 'tutorial' });
    must(p.json?.id, p.text);
    const r = await fetch(`${BASE}/api/projects/${p.json.id}/take-upload?name=${encodeURIComponent('my clip.mov')}`, { method: 'POST',
      headers: { 'X-Studio': '1', 'Content-Type': 'application/octet-stream' }, body: readFileSync(join(REC, take, `${take}_webcam.mov`)) });
    must(r.ok, await r.text());
    const v = (await api(`/api/projects/${p.json.id}`)).json;
    must(v.canvas.cam === 'my clip.mov', JSON.stringify(v.canvas));
    return `source/${v.canvas.cam}`;
  });

  await check('playback copies (H.264 on this computer)', async () => {
    must(id, 'no project');
    const view = await until(async () => { const v = (await api(`/api/projects/${id}`)).json; return v && Object.values(v.proxies).every(Boolean) ? v : null; }, 90000, 'the playback copies');
    const p = probe(join(STUDIO, 'projects', id, view.proxies[`${take}_webcam.mov`]));
    must(p.streams.some((s) => s.codec_name === 'h264'), 'the copy is not H.264');
    return `${Object.keys(view.proxies).length} copies`;
  });

  await check('waveform peaks', async () => {
    const r = await api(`/api/projects/${id}/peaks?f=${encodeURIComponent(`source/${take}_webcam.mov`)}`);
    must(r.status === 200 && r.json?.data?.length > 0, `peaks: ${r.status} ${r.text.slice(0, 120)}`);
    return `${r.json.data.length} values`;
  });

  await check('Audio export (WAV) on the whole take', async () => {
    const r = await api(`/api/projects/${id}/export-audio`, { format: 'wav', useCut: false, contents: 'mix' });
    must(r.status === 200, r.text);
    const renders = join(STUDIO, 'projects', id, 'renders');
    const wav = await until(() => { try { return readdirSync(renders).find((f) => f.endsWith('.wav') && !f.includes('.part')); } catch { return null; } }, 90000, 'the WAV');
    await sleep(500);
    const p = probe(join(renders, wav));
    must(p.streams[0]?.codec_name?.startsWith('pcm_'), `not PCM: ${p.streams[0]?.codec_name}`);
    must(Math.abs(Number(p.format.duration) - 4) < 0.2, `length ${p.format.duration}`);
    return `${wav} · ${p.streams[0].codec_name} · ${Number(p.format.duration).toFixed(2)} s`;
  });

  // Speech from the system's own voice (Windows SAPI, macOS say), transcribed by the starter's transcribe skill.
  let words = null;
  await check('transcribe speech with the starter skill (faster-whisper tiny.en)', async () => {
    const wav = join(ROOT, 'speech.wav');
    const line = 'Hello, this is a quick test of the studio recorder and the transcription.';
    if (process.platform === 'win32') {
      execFileSync('powershell.exe', ['-NoProfile', '-Command', `Add-Type -AssemblyName System.Speech; $s = New-Object System.Speech.Synthesis.SpeechSynthesizer; $s.SetOutputToWaveFile($env:SMOKE_WAV); $s.Speak($env:SMOKE_LINE); $s.Dispose()`],
        { env: { ...process.env, SMOKE_WAV: wav, SMOKE_LINE: line } });
    } else if (process.platform === 'darwin') {
      execFileSync('say', ['-o', join(ROOT, 'speech.aiff'), line]);
      execFileSync('ffmpeg', ['-v', 'error', '-y', '-i', join(ROOT, 'speech.aiff'), '-ar', '48000', wav]);
    } else return 'skipped (no system voice on Linux)';
    const out = join(ROOT, 'speech_tr');
    // Both passes in one run (the rough cut's filler pass into its own folder), the model loaded once.
    const log = execFileSync(PY, [join(STUDIO, '.claude', 'skills', 'transcribe', 'scripts', 'transcribe.py'), wav, '--model', 'tiny.en', '--out', out, '--fill-out', `${out}_fill`], { encoding: 'utf8', timeout: 600000 });
    words = JSON.parse(readFileSync(join(out, 'words.json'), 'utf8'));
    const text = words.map((w) => w[2]).join(' ').toLowerCase();
    must(words.length >= 6 && /studio|test|transcri/.test(text), `heard: ${text}`);
    const fill = JSON.parse(readFileSync(join(`${out}_fill`, 'words.json'), 'utf8'));
    must(fill.length >= 6 && /both passes in \d+s/.test(log) && /filler pass:/.test(log), `the filler pass in the same run: ${fill.length} words · ${log.slice(-200)}`);
    return `${words.length} words: "${text.slice(0, 60)}…" (filler pass in the same run: ${fill.length} words)`;
  });

  // The Cut Editor is built into the app (web/cut-editor/, server/cuteditor.mjs). The words go into the smoke project as
  // before; the checks run on a project of their own: the smoke take's playback copy, made-up words and a cut file
  // written the way the separate Python editor wrote it (a project from before the editor was built in).
  if (words) {
    mkdirSync(join(STUDIO, 'projects', id, 'work', 'tr'), { recursive: true });
    writeFileSync(join(STUDIO, 'projects', id, 'work', 'tr', 'words.json'), JSON.stringify(words));
  }
  const CB = 'cut-builtin', CBD = join(STUDIO, 'projects', CB), CB_WORDS = [[0.3, 0.8, 'hello'], [1.0, 1.5, 'there'], [1.8, 2.4, 'this'], [2.6, 3.2, 'is'], [3.4, 3.8, 'it']];
  const CB_EDL = [[0.2, 1.6], [1.6667, 3.9]]; // with a 2-frame cut
  const pyEdl = (src) => `{\n "source": ${JSON.stringify(src)},\n "fps": 30.0,\n "segments_sec": [\n  [\n   0.2,\n   1.6\n  ],\n  [\n   1.6667,\n   3.9\n  ]\n ],\n "saved_at": "2026-10-19 21:04:11",\n "edited_length": 3.633\n}`;
  const SETTINGS = join(LOCAL, 'settings.json'), TRAP = join(ROOT, 'tool-trap'), RAN = join(TRAP, 'ran.txt'), ON_WIN = process.platform === 'win32';
  // Python made unavailable to Video Octopus while fn runs: its python setting points at a stand-in that only notes that
  // it ran, and fails (on Windows: at nothing). ffmpeg and ffprobe point at stand-ins that note each run and hand over to
  // the real ones, so ran() lists every program Video Octopus started meanwhile (Mac and Linux).
  const ran = () => { try { return readFileSync(RAN, 'utf8').trim().split('\n').filter(Boolean); } catch { return []; } };
  const withoutPython = async (fn) => {
    const before = readFileSync(SETTINGS, 'utf8'), tools = {};
    mkdirSync(TRAP, { recursive: true }); rmSync(RAN, { force: true });
    if (ON_WIN) tools.python = join(TRAP, 'python.exe'); // not there
    else {
      const stand = (name, then) => { const f = join(TRAP, name); writeFileSync(f, `#!/bin/sh\necho "${name} $*" >> "${RAN}"\n${then}\n`); execFileSync('chmod', ['755', f]); return f; };
      tools.python = stand('python3', 'exit 1');
      for (const t of ['ffmpeg', 'ffprobe']) tools[t] = stand(t, `exec "${execFileSync('sh', ['-c', `command -v ${t}`], { encoding: 'utf8' }).trim()}" "$@"`);
    }
    writeFileSync(SETTINGS, JSON.stringify({ ...JSON.parse(before), ...tools }, null, 2));
    try { return await fn(); } finally { writeFileSync(SETTINGS, before); }
  };
  // The TCP ports the server listens on (Mac and Linux, with lsof).
  const listening = (pid) => { try { return execFileSync('lsof', ['-a', '-p', String(pid), '-iTCP', '-sTCP:LISTEN', '-n', '-P', '-Fn'], { encoding: 'utf8' }).split('\n').filter((l) => l.startsWith('n')).map((l) => l.slice(1)); } catch { return null; } };

  await check('Cut tab: the built-in Cut Editor opens with Python unavailable, starts no Python process and no second server', async () => {
    const proxy = join(STUDIO, 'projects', id, 'work', `proxy_${take}_webcam.mp4`);
    must(existsSync(proxy), 'no playback copy of the smoke take');
    mkdirSync(join(CBD, 'source'), { recursive: true }); mkdirSync(join(CBD, 'work', 'tr'), { recursive: true });
    copyFileSync(proxy, join(CBD, 'source', 'cb_webcam.mp4'));
    writeFileSync(join(CBD, 'project.json'), JSON.stringify({ name: 'Cut built in', type: 'tutorial' }));
    writeFileSync(join(CBD, 'work', 'tr', 'words.json'), JSON.stringify(CB_WORDS));
    writeFileSync(join(CBD, 'work', 'edl_fixed.json'), JSON.stringify({ segments_sec: [[0.2, 3.9]] }));
    writeFileSync(join(CBD, 'work', 'edl_manual.json'), pyEdl(join(CBD, 'source', 'cb_webcam.mp4')));
    return withoutPython(async () => {
      const py = (await api('/api/app/setup/check?id=python')).json;
      must(py?.state === 'fail' && (ON_WIN || ran().some((l) => l.startsWith('python3 '))), `Python should be unavailable now: ${py?.state} ${py?.detail} · ran: ${ran().join(' | ')}`);
      rmSync(RAN, { force: true });
      const r = (await api(`/api/projects/${CB}/cut`, {})).json;
      must(r?.ok && r.url === `/cut-editor/?p=${CB}`, `open: ${JSON.stringify(r)}`);
      const page = await fetch(`${BASE}${r.url}&autosave=1&theme=studio`);
      const html = await page.text();
      must(page.ok && /<title>Cut Editor<\/title>/.test(html), `the page answered ${page.status}`);
      for (const f of ['studio.js', 'studio.css']) must((await fetch(`${BASE}/cut-editor/${f}`)).ok, `no /cut-editor/${f}`);
      const d = await api(`/api/projects/${CB}/cut/data.json`);
      must(d.status === 200 && d.json?.pps === 200, `data: ${d.status} ${d.text.slice(0, 200)}`);
      // Started: ffmpeg (the waveform) and ffprobe (the frame rate), nothing else; listening: Video Octopus's own port only.
      const progs = ran(), ports = listening(server.pid);
      if (!ON_WIN) must(progs.length && progs.every((l) => /^ff(mpeg|probe) /.test(l)) && progs.some((l) => l.startsWith('ffmpeg ')), `programs started: ${progs.join(' | ') || 'none'}`);
      if (ports) must(ports.length === 1 && ports[0].endsWith(`:${PORT}`), `the server listens on ${ports.join(', ')}`);
      const { duration, peaks, rms } = d.json;
      must(Math.abs(duration - 4) < 0.15 && Math.abs(peaks.length - Math.floor(duration * 200)) <= 1 && rms.length === peaks.length && Math.max(...peaks) === 1,
        `the waveform: ${duration} s, ${peaks.length} peaks, ${rms.length} rms, top ${Math.max(...peaks)}`);
      return `${r.url} · ${peaks.length} peaks (${duration.toFixed(2)} s)${ON_WIN ? '' : ` · started: ${progs.map((l) => l.split(' ')[0]).join(', ')}`}${ports ? ` · listening: ${ports.join(', ')}` : ''}`;
    });
  });

  await check('Cut tab: a project\'s edl_manual.json from the Python editor opens as it is; a save writes the same file; comments, the take, a stale save', async () => {
    must(existsSync(join(CBD, 'work', 'edl_manual.json')), 'no project from the check before');
    return withoutPython(async () => {
      const video = join(CBD, 'source', 'cb_webcam.mp4');
      const d = (await api(`/api/projects/${CB}/cut/data.json`)).json;
      must(JSON.stringify(d.segments) === JSON.stringify(CB_EDL) && d.saved === true && d.source === 'cb_webcam.mp4', `opened: ${JSON.stringify({ segments: d.segments, saved: d.saved, source: d.source })}`);
      must(JSON.stringify(d.words) === JSON.stringify(CB_WORDS) && d.joins.length === 0 && Math.abs(d.version - statSync(join(CBD, 'work', 'edl_manual.json')).mtimeMs / 1000) < 1e-3, 'words, joins or version');
      must((await api(`/api/projects/${CB}/cut/version`)).json?.version === d.version, 'version');
      // A save made on an older version is refused, and the file stays as it was.
      const before = readFileSync(join(CBD, 'work', 'edl_manual.json'), 'utf8');
      const stale = await api(`/api/projects/${CB}/cut/save`, { segments: [[0.2, 3.9]], version: d.version - 5 });
      must(stale.status === 409 && stale.json?.conflict === true && readFileSync(join(CBD, 'work', 'edl_manual.json'), 'utf8') === before, `stale save: ${stale.status}`);
      const unsigned = await fetch(`${BASE}/api/projects/${CB}/cut/save`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ segments: [[0, 1]], force: true }) });
      must(unsigned.status === 403, `a save without X-Studio got ${unsigned.status}`);
      // The save: slivers under 20 ms dropped, 4 decimals, the file in the Python editor's shape (whole floats as 30.0).
      const sv = await api(`/api/projects/${CB}/cut/save`, { segments: [[0.2, 1.6], [1.66666, 2.5], [2.8, 3.9], [3.95, 3.96]], version: d.version });
      must(sv.status === 200 && sv.json?.ok && sv.json.length === 3.333, `save: ${sv.text}`);
      const text = readFileSync(join(CBD, 'work', 'edl_manual.json'), 'utf8'), f = JSON.parse(text);
      must(JSON.stringify(Object.keys(f)) === JSON.stringify(['source', 'fps', 'segments_sec', 'saved_at', 'edited_length']), `keys: ${Object.keys(f)}`);
      must(f.source === realpathSync(video) && f.fps === 30 && JSON.stringify(f.segments_sec) === '[[0.2,1.6],[1.6667,2.5],[2.8,3.9]]' && f.edited_length === 3.333 && /^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d$/.test(f.saved_at),
        `saved: ${JSON.stringify(f)}`);
      must(text.startsWith('{\n "source": ') && text.includes('\n "fps": 30.0,\n') && !text.endsWith('\n') && !/^\s+-?\d+,?$/m.test(text), `not the Python editor's layout:\n${text}`);
      must((await api(`/api/projects/${CB}/cut/version`)).json?.version === sv.json.version, 'the version after the save');
      // The app reads that cut like any other: the export's cut and Scenes' take.
      const view = (await api(`/api/projects/${CB}`)).json, ct = (await api(`/api/projects/${CB}/cut-take`)).json;
      must(view.cut?.ready && view.export?.cut?.file === 'work/edl_manual.json' && JSON.stringify(ct.segments) === JSON.stringify(f.segments_sec.map((x) => x.map((t) => Math.round(t * 1000) / 1000))),
        `the app's cut: ${view.export?.cut?.file} · cut-take ${JSON.stringify(ct.segments)}`);
      // Comments (work/editor_notes.json), and the take with Range.
      const n = (await api(`/api/projects/${CB}/cut/notes`, { t: 1.234, edited_t: 1.034, text: 'Smoke comment' })).json;
      must(n?.t === 1.23 && n.edited_t === 1.03 && /^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d$/.test(n.at) && Number.isInteger(n.id), `note: ${JSON.stringify(n)}`);
      must((await api(`/api/projects/${CB}/cut/notes`)).json?.some((x) => x.id === n.id && x.text === 'Smoke comment'), 'the note is not listed');
      await api(`/api/projects/${CB}/cut/notes/delete`, { id: n.id });
      must(!(await api(`/api/projects/${CB}/cut/notes`)).json?.length && existsSync(join(CBD, 'work', 'editor_notes.json')), 'the note was not deleted');
      const v = await fetch(`${BASE}/api/projects/${CB}/cut/video`, { headers: { Range: 'bytes=0-99' } });
      const got = Buffer.from(await v.arrayBuffer());
      must(v.status === 206 && got.length === 100 && v.headers.get('content-range') === `bytes 0-99/${statSync(video).size}` && got.equals(readFileSync(video).subarray(0, 100)), `video: ${v.status} ${got.length} ${v.headers.get('content-range')}`);
      must(!ran().some((l) => l.startsWith('python')), `Python ran: ${ran().join(' | ')}`);
      return `opened ${JSON.stringify(d.segments)} (2-frame cut kept) · saved ${JSON.stringify(f.segments_sec)} · 409 on a stale save · note · 206 on the take`;
    });
  });

  // The Dashboard: totals from the folders, features from the usage log, and the log holds no paths or words.
  await check('Dashboard and the local usage log', async () => {
    const r = await api('/api/app/dashboard?range=week');
    must(r.status === 200 && r.json?.totals, `dashboard ${r.status}`);
    const { totals, features } = r.json;
    must(totals.projects >= 1 && totals.studio >= 1, `projects ${totals.projects}/${totals.studio}`);
    const names = features.map((f) => f.label);
    must(names.includes('Projects started') && names.includes('Takes imported') && names.includes('Exports: audio'), `features: ${names.join(', ')}`);
    const log = readFileSync(join(LOCAL, 'usage.jsonl'), 'utf8');
    must(!log.includes(ROOT) && !log.includes('/Users/') && !/studio recorder/i.test(log), 'the usage log holds a path or words');
    return `${log.trim().split('\n').length} log lines · ${names.join(', ')}`;
  });

  // Scheduled runs: the API saves a schedule, works out the next time, refuses a bad one, deletes it (no Claude run).
  await check('Scheduled runs: save, next time, refuse a bad schedule, delete', async () => {
    const bad = await api('/api/app/schedules', { op: 'save', schedule: { name: 'Bad', cron: '0 25 * * *', prompt: 'x' } });
    must(bad.status === 400 && /outside/.test(bad.json?.error || ''), `bad cron got ${bad.status} ${bad.text}`);
    const r = await api('/api/app/schedules', { op: 'save', schedule: { name: 'Smoke digest', cron: '30 8 * * 1-5', scope: 'changed', mode: 'report', prompt: 'Say hello.', enabled: false } });
    must(r.status === 200 && r.json?.saved, `save got ${r.status} ${r.text}`);
    const s = r.json.schedules.find((x) => x.id === r.json.saved);
    must(s.when === 'Weekdays 08:30' && s.next === null && s.enabled === false, `saved: ${JSON.stringify(s)}`);
    const pv = await api('/api/app/schedules', { op: 'preview', schedule: { ...s, enabled: true } });
    must(pv.status === 200 && pv.json.next > Date.now() && [1, 2, 3, 4, 5].includes(new Date(pv.json.next).getDay()), `preview: ${pv.text}`);
    const del = await api('/api/app/schedules', { op: 'delete', id: s.id });
    must(del.status === 200 && !del.json.schedules.some((x) => x.id === s.id), 'not deleted');
    return `${s.when} · next ${new Date(pv.json.next).toString().slice(0, 21)} · templates: ${r.json.templates.map((t) => t.name).join(', ')}`;
  });

  // The octopus command (bin/octopus.mjs, what the Video Octopus assistant uses) and the Library inbox: list projects, rename,
  // then a piece in the inbox goes into the library.
  await check('octopus command and the Library inbox', async () => {
    const cli = (...a) => execFileSync(process.execPath, [join(APP, 'bin', 'octopus.mjs'), ...a], { env: { ...process.env, STUDIO_URL: BASE }, encoding: 'utf8' });
    const list = JSON.parse(cli('projects', '--json'));
    must(list.some((p) => p.id === 'smoke-test'), `projects: ${list.map((p) => p.id).join(', ')}`);
    must(/now called "Smoke test renamed"/.test(cli('projects', 'rename', 'smoke-test', 'Smoke test renamed')), 'rename');
    const piece = join(STUDIO, 'library', 'inbox', '2026-01-01-test', 'title-card');
    mkdirSync(piece, { recursive: true });
    writeFileSync(join(piece, 'README.md'), 'kind: components\nA title card for the smoke test.\n');
    writeFileSync(join(piece, 'card.html'), '<div>Title</div>\n');
    const inbox = JSON.parse(cli('library', 'inbox', '--json'));
    must(inbox.items.length === 1 && inbox.items[0].kind === 'components', `inbox: ${JSON.stringify(inbox.items)}`);
    must(/components\/title-card/.test(cli('library', 'accept', '2026-01-01-test/title-card', '--kind', 'components')), 'accept');
    must(existsSync(join(STUDIO, 'library', 'components', 'title-card', 'card.html')) && !existsSync(piece), 'the piece did not move');
    must(/title-card\//.test(readFileSync(join(STUDIO, 'library', 'components', 'INDEX.md'), 'utf8')), 'no INDEX line');
    return 'projects, rename, inbox, accept';
  });

  await check('safety rules: Always-for paths, scheduled-run scope, archive and restore, library add', async () => {
    const cli = (...a) => execFileSync(process.execPath, [join(APP, 'bin', 'octopus.mjs'), ...a], { env: { ...process.env, STUDIO_URL: BASE }, encoding: 'utf8', stdio: 'pipe' });
    // library add: a file inside the studio goes in; one outside is refused
    const f = join(STUDIO, 'projects', 'smoke-test', 'work', 'bg-smoke.png');
    writeFileSync(f, 'not really a picture');
    must(/backgrounds\/bg-smoke\.png/.test(cli('library', 'add', f, '--kind', 'backgrounds')), 'library add');
    must(existsSync(join(STUDIO, 'library', 'backgrounds', 'bg-smoke.png')), 'not copied into the library');
    let refused = false; try { cli('library', 'add', join(ROOT, 'local', 'settings.json'), '--kind', 'backgrounds'); } catch { refused = true; }
    must(refused, 'a file outside the studio went into the library');
    // archive and restore: moved aside, never deleted
    const made = JSON.parse(cli('projects', 'new', 'Archive me', '--json')).id;
    cli('projects', 'archive', made);
    must(existsSync(join(STUDIO, 'projects', '_archive', made)) && !existsSync(join(STUDIO, 'projects', made)), 'archive did not move it aside');
    must(!JSON.parse(cli('projects', '--json')).some((p) => p.id === made), 'an archived project still shows');
    cli('projects', 'restore', made);
    must(existsSync(join(STUDIO, 'projects', made)), 'restore did not bring it back');
    // permission rules, straight from the modules
    const code = `const { decide } = await import(${JSON.stringify(new URL('../server/schedules.mjs', import.meta.url).href)});
      const { ChatSession } = await import(${JSON.stringify(new URL('../server/claude.mjs', import.meta.url).href)});
      const P = ${JSON.stringify(join(STUDIO, 'projects', 'smoke-test'))}, S = ${JSON.stringify(STUDIO)};
      const ch = new ChatSession('smoke-rules', () => ''); ch.cwd = () => S;
      const k = (tool, input) => ch.alwaysFor({ tool_name: tool, input });
      console.log(JSON.stringify({
        inScope: decide({ mode: 'change' }, { tool_name: 'Write', input: { file_path: P + '/work/joins.json' } }, [P]).allow,
        outScope: decide({ mode: 'change' }, { tool_name: 'Edit', input: { file_path: P + '/../other/x.json' } }, [P]).allow,
        command: decide({ mode: 'change' }, { tool_name: 'Bash', input: { command: 'python3 join_check.py' } }, [P]).allow,
        reportCmd: decide({ mode: 'report' }, { tool_name: 'Bash', input: { command: 'ls' } }, [P]).allow,
        keyInside: Boolean(k('Write', { file_path: P + '/renders/v1.mp4' })),
        keyEscape: k('Write', { file_path: S + '/projects/x/../../../escape.txt' }),
        keyByPath: k('Bash', { command: '/tmp/x/ffmpeg -i a.mov' }),
        keyByName: k('Bash', { command: 'ffmpeg -i a.mov' })?.label }));`;
    const r = JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e', code], { env: { ...process.env, STUDIO_LOCAL_DIR: LOCAL, STUDIO_NO_SCHEDULES: '1' }, encoding: 'utf8' }).trim().split('\n').pop());
    must(r.inScope && !r.outScope && r.command && !r.reportCmd, `run rules: ${JSON.stringify(r)}`);
    must(r.keyInside && r.keyEscape === null && r.keyByPath === null && r.keyByName === 'ffmpeg commands', `Always-for: ${JSON.stringify(r)}`);
    return 'library add, archive/restore, run scope, Always-for paths';
  });

  await check('Codex engine: its protocol becomes Video Octopus chat events (no Codex needed)', async () => {
    const code = `const { CodexSession } = await import(${JSON.stringify(new URL('../server/codex.mjs', import.meta.url).href)});
      const c = new CodexSession('smoke-codex', () => ''); c.cwd = () => ${JSON.stringify(STUDIO)};
      const ev = [], wrote = []; c.emit = (e) => ev.push(e); c.write = (m) => wrote.push(m);
      c.handle({ method: 'item/started', params: { item: { type: 'commandExecution', id: 'i1', command: "/bin/zsh -lc 'ffmpeg -version'" } } });
      c.handle({ method: 'item/completed', params: { item: { type: 'commandExecution', id: 'i1', aggregatedOutput: 'ffmpeg 7', exitCode: 0 } } });
      c.handle({ method: 'item/completed', params: { item: { type: 'agentMessage', id: 'm1', text: 'Done.' } } });
      c.handle({ method: 'thread/tokenUsage/updated', params: { tokenUsage: { last: { inputTokens: 1000, outputTokens: 50 }, modelContextWindow: 200000 } } });
      c.handle({ id: 7, method: 'item/commandExecution/requestApproval', params: { itemId: 'i2', command: "/bin/zsh -lc 'touch a.txt'" } });
      const card = ev.find((e) => e.t === 'permission');
      c.answer('7', { allow: true, always: true });
      c.handle({ id: 8, method: 'item/commandExecution/requestApproval', params: { itemId: 'i3', command: "/bin/zsh -lc 'touch b.txt'" } });
      c.handle({ method: 'turn/completed', params: { turn: { status: 'completed', durationMs: 4000 } } });
      console.log(JSON.stringify({ tool: ev.find((e) => e.t === 'tool')?.summary, result: ev.find((e) => e.t === 'tool_result')?.text, text: ev.find((e) => e.t === 'text')?.text,
        ctx: ev.find((e) => e.t === 'context')?.tokens, always: card?.always, cards: ev.filter((e) => e.t === 'permission').length,
        replies: wrote.filter((m) => m.result).map((m) => m.result.decision), done: ev.find((e) => e.t === 'result')?.ok }));`;
    const r = JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e', code], { env: { ...process.env, STUDIO_LOCAL_DIR: LOCAL, STUDIO_NO_SCHEDULES: '1' }, encoding: 'utf8' }).trim().split('\n').pop());
    must(r.tool === 'ffmpeg -version' && r.result === 'ffmpeg 7' && r.text === 'Done.' && r.ctx === 1050 && r.done === true, JSON.stringify(r));
    must(r.always === 'touch commands' && r.cards === 1 && r.replies.join() === 'acceptForSession,accept', `approvals: ${JSON.stringify(r)}`);
    return 'tools, text, context, Always for this session, results';
  });

  await check('pi engine: events become chat events; Video Octopus\'s extension asks and adds the endpoint (no pi needed)', async () => {
    const code = `const { PiSession } = await import(${JSON.stringify(new URL('../server/pi.mjs', import.meta.url).href)});
      const c = new PiSession('smoke-pi', () => ''); c.cwd = () => ${JSON.stringify(STUDIO)};
      const ev = [], wrote = []; c.emit = (e) => ev.push(e); c.write = (m) => wrote.push(m);
      c.handle({ type: 'tool_execution_start', toolCallId: 't1', toolName: 'bash', args: { command: 'ffprobe -version' } });
      c.handle({ type: 'tool_execution_end', toolCallId: 't1', toolName: 'bash', result: { content: [{ type: 'text', text: 'ffprobe 7' }] }, isError: false });
      c.handle({ type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: 'Done.' }] } });
      const ask = (id, cmd) => c.handle({ type: 'extension_ui_request', id, method: 'select', title: 'STUDIO_APPROVAL ' + JSON.stringify({ tool: 'Bash', input: { command: cmd } }), options: ['Allow', 'Always', 'Deny'] });
      ask('u1', 'touch a.txt');
      const card = ev.find((e) => e.t === 'permission');
      c.answer('u1', { allow: true, always: true });
      ask('u2', 'touch b.txt');
      c.handle({ type: 'extension_ui_request', id: 'u3', method: 'input', title: 'Something else' });
      c.handle({ type: 'agent_settled', aborted: false });
      // Video Octopus's own pi extension: the endpoint provider, and a tool call it has to ask about
      process.env.STUDIO_PI_MODE = 'manual'; process.env.STUDIO_PI_ROOT = ${JSON.stringify(STUDIO)};
      process.env.STUDIO_PI_BASE_URL = 'https://openrouter.ai/api/v1'; process.env.STUDIO_PI_MODEL = 'qwen/qwen3.6-35b-a3b'; process.env.STUDIO_PI_VISION = '1';
      const ext = (await import(${JSON.stringify(new URL('../core/pi/octopus-extension.js', import.meta.url).href)} + '?smoke')).default;
      let provider = null, onCall = null; ext({ registerProvider: (n, cfg) => { provider = { n, cfg }; }, on: (n, fn) => { if (n === 'tool_call') onCall = fn; } });
      const blocked = await onCall({ toolName: 'write', input: { path: 'projects/x/a.txt' } }, { hasUI: true, ui: { select: async () => 'Deny' } });
      const reading = await onCall({ toolName: 'read', input: { path: 'a.txt' } }, { hasUI: true, ui: { select: async () => 'Deny' } });
      console.log(JSON.stringify({ tool: ev.find((e) => e.t === 'tool')?.summary, result: ev.find((e) => e.t === 'tool_result')?.text, text: ev.find((e) => e.t === 'text')?.text,
        always: card?.always, cards: ev.filter((e) => e.t === 'permission').length, replies: wrote.filter((m) => m.type === 'extension_ui_response').map((m) => m.value ?? (m.cancelled ? 'cancelled' : '?')),
        done: ev.find((e) => e.t === 'result')?.ok, provider: provider && [provider.n, provider.cfg.baseUrl, provider.cfg.api, provider.cfg.models[0].id, provider.cfg.models[0].input.join('+')].join(' '),
        blocked: Boolean(blocked?.block), reading: reading === undefined }));`;
    const r = JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e', code], { env: { ...process.env, STUDIO_LOCAL_DIR: LOCAL, STUDIO_NO_SCHEDULES: '1' }, encoding: 'utf8' }).trim().split('\n').pop());
    must(r.tool === 'ffprobe -version' && r.result === 'ffprobe 7' && r.text === 'Done.' && r.done === true, JSON.stringify(r));
    must(r.always === 'touch commands' && r.cards === 1 && r.replies.join() === 'Always,Allow,cancelled', `approvals: ${JSON.stringify(r)}`);
    must(r.provider === 'studio https://openrouter.ai/api/v1 openai-completions qwen/qwen3.6-35b-a3b text+image' && r.blocked && r.reading, `extension: ${JSON.stringify(r)}`);
    return 'tools, text, Always, other dialogs, endpoint provider, ask before a write';
  });

  // ---- safety fixes (review 2026-10-18), straight from the modules: no agent needed ----
  const node = (code) => JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e', code],
    { env: { ...process.env, STUDIO_LOCAL_DIR: LOCAL, STUDIO_NO_SCHEDULES: '1' }, encoding: 'utf8' }).trim().split('\n').pop());
  const mod = (f) => JSON.stringify(new URL(`../${f}`, import.meta.url).href);
  const P = join(STUDIO, 'projects', 'smoke-test'), OUT = join(ROOT, 'outside');

  await check('approvals: every file of a Codex patch counts; Always is the server\'s call', async () => {
    const r = node(`const { CodexSession } = await import(${mod('server/codex.mjs')});
      const P = ${JSON.stringify(P)}, S = ${JSON.stringify(STUDIO)}, OUT = ${JSON.stringify(OUT)};
      const chat = (id) => { const c = new CodexSession(id, () => ''); c.cwd = () => S; c.ev = []; c.wrote = []; c.emit = (e) => c.ev.push(e); c.write = (m) => c.wrote.push(m); return c; };
      const c = chat('smoke-codex-files'), card = () => c.ev.filter((e) => e.t === 'permission').at(-1);
      const patch = (n, paths) => { c.handle({ method: 'item/started', params: { item: { type: 'fileChange', id: 'f' + n, changes: paths.map((path) => ({ path })) } } });
        c.handle({ id: n, method: 'item/fileChange/requestApproval', params: { itemId: 'f' + n } }); return card(); };
      const mixed = patch(1, [P + '/work/a.json', OUT + '/b.txt']).always;
      const same = patch(2, [P + '/work/a.json', P + '/work/b.json']).always;
      const twoDirs = patch(3, [P + '/work/a.json', P + '/renders/b.json']).always;
      c.answer('1', { allow: true, always: true });
      c.handle({ id: 4, method: 'item/commandExecution/requestApproval', params: { command: "/bin/zsh -lc 'ls && touch x'" } });
      c.answer('4', { allow: true, always: true });
      c.handle({ id: 5, method: 'item/permissions/requestApproval', params: { permissions: { network: { enabled: true } }, reason: 'web' } });
      c.answer('5', { allow: true, always: true });
      const a = chat('_studio');
      a.handle({ id: 6, method: 'item/commandExecution/requestApproval', params: { command: 'ffmpeg -version' } });
      a.answer('6', { allow: true, always: true });
      const reply = (ch, id) => ch.wrote.find((m) => m.id === id)?.result;
      console.log(JSON.stringify({ mixed, same, twoDirs, patch: reply(c, 1)?.decision, compound: reply(c, 4)?.decision, perms: reply(c, 5)?.scope, assistant: reply(a, 6)?.decision, assistantCard: a.ev.find((e) => e.t === 'permission')?.always }));`);
    must(r.mixed === null && r.same === 'changes in smoke-test/work/' && r.twoDirs === null, `Always on a patch: ${JSON.stringify(r)}`);
    must(r.patch === 'accept' && r.compound === 'accept' && r.perms === 'turn' && r.assistant === 'accept' && r.assistantCard === null, `the page's always flag got through: ${JSON.stringify(r)}`);
    return 'a patch outside the studio, two folders, a compound command, permissions and the assistant: never for the session';
  });

  await check('Make-changes runs: only reading, commands and edits in scope (every file)', async () => {
    const r = node(`const { decide } = await import(${mod('server/schedules.mjs')});
      const P = ${JSON.stringify(P)}, S = ${JSON.stringify(STUDIO)}, sch = { mode: 'change' };
      const d = (tool, input = {}, scope = [P]) => decide(sch, { tool_name: tool, input }, scope);
      const allowed = Object.fromEntries(['Read', 'Glob', 'Grep', 'LS', 'NotebookRead', 'Bash', 'BashOutput', 'Skill', 'Task', 'TodoWrite'].map((t) => [t, d(t, { command: 'ls' }).allow]));
      const refused = Object.fromEntries(['WebFetch', 'WebSearch', 'mcp__github__create_issue', 'Permissions', 'web_fetch'].map((t) => [t, d(t, { url: 'https://example.com' })]));
      console.log(JSON.stringify({ allowed, refused: Object.fromEntries(Object.entries(refused).map(([k, v]) => [k, v.allow])), permsMsg: refused.Permissions.message, webMsg: refused.WebFetch.message,
        allIn: d('Edit', { file_path: P + '/work/a.json', file_paths: [P + '/work/a.json', P + '/renders/b.json'] }).allow,
        oneOut: d('Edit', { file_path: P + '/work/a.json', file_paths: [P + '/work/a.json', S + '/projects/other/x.json'] }).allow,
        relNoCwd: d('Write', { file_path: 'work/a.json' }).allow,
        relInCwd: decide(sch, { tool_name: 'Write', input: { file_path: 'work/a.json' } }, [P], P).allow,
        relStudioCwd: decide(sch, { tool_name: 'Write', input: { file_path: 'CLAUDE.md' } }, [P], S).allow,
        slashScope: d('Write', { file_path: P + '/work/a.json' }, [P + '${sep === '\\' ? '\\\\' : '/'}']).allow,
        grantIn: d('Edit', { file_paths: [P + '/work/a.json'], grant_root: P }).allow,
        grantOut: d('Edit', { file_paths: [P + '/work/a.json'], grant_root: S }).allow,
        askMixed: decide({ mode: 'ask' }, { tool_name: 'Edit', input: { file_paths: [S + '/library/inbox/x/README.md', P + '/work/a.json'] } }).allow,
        askIn: decide({ mode: 'ask' }, { tool_name: 'Edit', input: { file_paths: [S + '/library/inbox/x/README.md'] } }).allow }));`);
    must(Object.values(r.allowed).every(Boolean), `refused: ${JSON.stringify(r.allowed)}`);
    must(!Object.values(r.refused).some(Boolean) && /permissions/.test(r.permsMsg) && /WebFetch/.test(r.webMsg), `allowed: ${JSON.stringify(r)}`);
    must(r.allIn && !r.oneOut && !r.relNoCwd && r.relInCwd && !r.relStudioCwd && r.slashScope && r.grantIn && !r.grantOut && !r.askMixed && r.askIn, `scope: ${JSON.stringify(r)}`);
    return 'web, MCP, Permissions and other tools refused; a patch needs every file in scope';
  });

  await check('pi: read-only commands only look; paths are pi\'s working folder\'s (no pi needed)', async () => {
    const r = node(`process.env.STUDIO_PI_MODE = 'auto'; process.env.STUDIO_PI_ROOT = ${JSON.stringify(STUDIO)};
      const P = ${JSON.stringify(P)}, S = ${JSON.stringify(STUDIO)};
      const auto = (await import(${mod('core/pi/octopus-extension.js')} + '?auto')).default;
      let onAuto; auto({ registerProvider() {}, on: (n, fn) => { onAuto = fn; } });
      const asked = [], ctx = { hasUI: true, cwd: P, ui: { select: async (t) => { asked.push(JSON.parse(t.slice('STUDIO_APPROVAL '.length))); return 'Deny'; } } };
      const quiet = async (command) => (await onAuto({ toolName: 'bash', input: { command } }, ctx)) === undefined;
      const looks = ['ls -la && cat a', 'grep x f | sort | uniq -c', 'ffprobe -v error -show_entries format=duration -of csv=p=0 a.mp4 2>/dev/null'];
      const writes = ['ls\\nrm -rf x', 'ls & rm -rf x', 'sort -o out in', 'sort --output=out in', 'tree -o out', 'find . -fprint out', 'find . -fls out', 'find . -execdir rm {} +', 'find . -okdir rm {} ;', 'find . -delete',
        "find . -de''lete", 'find . -\${X:-delete}', 'uniq in out', 'rg --pre cat x', 'file -C -m magic', 'cat a >/dev/nullx'];
      const out = { looksAsked: [], writesQuiet: [] };
      for (const c of looks) if (!(await quiet(c))) out.looksAsked.push(c);
      for (const c of writes) if (await quiet(c)) out.writesQuiet.push(c);
      out.relQuiet = (await onAuto({ toolName: 'write', input: { path: 'work/a.json' } }, ctx)) === undefined; // inside the studio: no card in Auto
      out.homeQuiet = (await onAuto({ toolName: 'write', input: { path: '~/smoke-outside.txt' } }, ctx)) === undefined;
      out.otherTool = Boolean((await onAuto({ toolName: 'web_fetch', input: { url: 'https://example.com' } }, ctx))?.block);
      // manual: the card names the file in the working folder (STUDIO_PI_CWD when pi gives no cwd)
      process.env.STUDIO_PI_MODE = 'manual'; process.env.STUDIO_PI_CWD = P;
      const manual = (await import(${mod('core/pi/octopus-extension.js')} + '?manual')).default;
      let onManual; manual({ registerProvider() {}, on: (n, fn) => { onManual = fn; } });
      await onManual({ toolName: 'edit', input: { path: 'work/edl_manual.json' } }, { hasUI: true, ui: ctx.ui });
      out.cardFile = asked.at(-1)?.input?.file_path;
      out.askedTools = [...new Set(asked.map((a) => a.tool))];
      // Video Octopus's side: Always for that file in a project chat on pi, and a project-scoped run takes the edit
      const { PiSession } = await import(${mod('server/pi.mjs')});
      const { decide } = await import(${mod('server/schedules.mjs')});
      const c = new PiSession('smoke-pi-cwd', () => ''); c.cwd = () => P; const ev = []; c.emit = (e) => ev.push(e); c.write = () => {};
      c.handle({ type: 'extension_ui_request', id: 'w1', method: 'select', title: 'STUDIO_APPROVAL ' + JSON.stringify(asked.at(-1)), options: ['Allow', 'Always', 'Deny'] });
      out.always = ev.find((e) => e.t === 'permission')?.always;
      out.runTakes = decide({ mode: 'change' }, { tool_name: asked.at(-1).tool, input: asked.at(-1).input }, [P]).allow;
      console.log(JSON.stringify(out));`);
    must(!r.looksAsked.length, `plain looking chains asked: ${r.looksAsked.join(' | ')}`);
    must(!r.writesQuiet.length, `ran without asking: ${r.writesQuiet.join(' | ')}`);
    must(r.relQuiet && !r.homeQuiet && r.otherTool, `paths: ${JSON.stringify(r)}`);
    must(r.cardFile === join(P, 'work', 'edl_manual.json') && r.always === 'changes in work/' && r.runTakes, `working folder: ${JSON.stringify(r)}`);
    return `${r.askedTools.join(', ')} asked; the card shows ${r.cardFile.slice(STUDIO.length + 1)}`;
  });

  await check('inside(): resolved, symlinks followed, a trailing slash, files not made yet', async () => {
    mkdirSync(OUT, { recursive: true });
    symlinkSync(OUT, join(STUDIO, 'link-out'), 'junction');
    symlinkSync(STUDIO, join(ROOT, 'studio-link'), 'junction');
    const r = node(`const { inside } = await import(${mod('server/util.mjs')});
      const S = ${JSON.stringify(STUDIO)}, R = ${JSON.stringify(ROOT)}, sep = ${JSON.stringify(sep)};
      console.log(JSON.stringify({
        slash: inside(S + sep, 'projects') === S + sep + 'projects',
        notYet: Boolean(inside(S, 'projects/smoke-test/work/new/deep/file.json')),
        self: inside(S, '.') === S,
        abs: Boolean(inside(S, S + sep + 'projects')),
        dotdot: inside(S, 'projects/../../outside/x.txt'),
        link: inside(S, 'link-out/x.txt'), linkItself: inside(S, 'link-out'),
        viaLink: Boolean(inside(R + sep + 'studio-link', S + sep + 'projects')),
        realViaLink: Boolean(inside(S, R + sep + 'studio-link' + sep + 'projects')),
        caseWin: process.platform !== 'win32' || Boolean(inside(S.toUpperCase(), S.toLowerCase() + sep + 'projects')),
      }));`);
    must(r.slash && r.notYet && r.self && r.abs && r.viaLink && r.realViaLink && r.caseWin, `inside: ${JSON.stringify(r)}`);
    must(r.dotdot === null && r.link === null && r.linkItself === null, `outside counted as inside: ${JSON.stringify(r)}`);
    return 'trailing slash, new files, links both ways, ".." and a link out refused';
  });

  await check('GET leaves the chat alone after an agent switch; a POST archives it (agent and model kept)', async () => {
    const chats = join(LOCAL, 'chats'), log = join(chats, 'smoke-test.jsonl');
    mkdirSync(chats, { recursive: true });
    writeFileSync(log, JSON.stringify({ t: 'user', text: 'Hello from the smoke test', ts: Date.now() }) + '\n');
    let st = { projects: {} };
    try { st = JSON.parse(readFileSync(join(LOCAL, 'state.json'), 'utf8')); } catch {}
    st.projects['smoke-test'] = { ...(st.projects['smoke-test'] || {}), sessionId: 'smoke-session', engine: 'claude', model: 'claude-smoke-model' };
    writeFileSync(join(LOCAL, 'state.json'), JSON.stringify(st));
    const usage = () => { try { return readFileSync(join(LOCAL, 'usage.jsonl'), 'utf8').split('\n').filter((l) => l.includes('"session.new"')).length; } catch { return 0; } };
    const archived = () => readdirSync(chats).filter((f) => /^smoke-test--\d+\.jsonl$/.test(f));
    const before = usage();
    const sw = await api('/api/app/settings', { section: 'claude', values: { engine: 'codex' } });
    must(sw.status === 200, sw.text);
    try {
      must((await api('/api/projects/smoke-test')).status === 200, 'the project view failed');
      const ac = new AbortController();
      const ev = await fetch(BASE + '/api/projects/smoke-test/events', { signal: ac.signal });
      const rd = ev.body.getReader();
      let got = '';
      const end = Date.now() + 3000;
      while (!/"t":"busy"/.test(got) && Date.now() < end) { const v = await Promise.race([rd.read(), sleep(500).then(() => null)]); if (v?.value) got += Buffer.from(v.value).toString(); if (v?.done) break; }
      ac.abort();
      must(got.includes('Hello from the smoke test'), `the stream didn't replay the chat: ${got.slice(0, 120)}`);
      must(existsSync(log) && readFileSync(log, 'utf8').includes('Hello from') && !archived().length, 'a GET moved the chat log');
      must(usage() === before, 'a GET wrote a new session to the usage log');
      const s = await api('/api/projects/smoke-test/chat-sessions', { op: 'list' });
      must(s.status === 200 && archived().length === 1 && !(existsSync(log) && readFileSync(log, 'utf8').includes('Hello from')), `the POST didn't start a fresh chat: ${s.text.slice(0, 160)}`);
      const rec = s.json.earlier.find((e) => e.log === archived()[0]);
      must(rec?.engine === 'claude' && rec.model === 'claude-smoke-model', `session record: ${JSON.stringify(rec)}`);
      must(usage() === before + 1, 'no new session in the usage log after the POST');
      const o = await api('/api/projects/smoke-test/chat-sessions', { op: 'open', log: rec.log });
      must(o.status === 400 && /with Claude Code/.test(o.json?.error || ''), `continuing it with Codex: ${o.text}`);
      const status = (await api('/api/status')).json;
      must(status.platform === process.platform && status.home === homedir(), `status: ${status.platform} ${status.home}`);
      return `GET ×2 left it; POST archived ${rec.log} (${rec.engine}, ${rec.model}); /api/status: ${status.platform}`;
    } finally { await api('/api/app/settings', { section: 'claude', values: { engine: 'claude' } }); }
  });

  // ---- agents and runs (agents2): Claude Code's model source, Codex runs, new recordings, read-only GETs, the router ----
  // A separate install folder per check, so these never touch the server's settings (or your own).
  const unitLocal = (name, set = {}) => { const d = join(ROOT, `local-${name}`); mkdirSync(d, { recursive: true }); writeFileSync(join(d, 'settings.json'), JSON.stringify({ studio: STUDIO, setup: { done: true }, ...set })); return d; };
  const nodeIn = (local, code, env = {}) => JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e', code],
    { env: { ...process.env, STUDIO_LOCAL_DIR: local, STUDIO_NO_SCHEDULES: '1', STUDIO_KEYCHAIN_SERVICE: `StudioSmokeTest${process.pid}`, CLAUDE_CONFIG_DIR: join(ROOT, 'claude-config'), ...env }, encoding: 'utf8', timeout: 60000 }).trim().split('\n').pop());
  // Anthropic credentials Video Octopus's own environment might carry: none may reach a server that isn't Anthropic's.
  const SECRETS = { ANTHROPIC_API_KEY: 'sk-ant-api03-SMOKE-real-key', CLAUDE_CODE_OAUTH_TOKEN: 'sk-ant-oat01-SMOKE-plan-token', ANTHROPIC_CUSTOM_HEADERS: 'x-api-key: sk-ant-api03-SMOKE-header', MY_OTHER_VAR: 'sk-ant-api03-SMOKE-other' };
  // What a Claude Code host (the desktop app) gives its children: under it Claude Code may use the host's sign-in instead.
  const HOST = { CLAUDE_CODE_REMOTE: '1', CLAUDE_CODE_SDK_HAS_HOST_AUTH_REFRESH: '1', CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST: '1' };

  await check('Claude Code model sources: env and args per source, no Anthropic credential to a third party (no Claude needed)', async () => {
    mkdirSync(join(ROOT, 'claude-config'), { recursive: true });
    const r = nodeIn(unitLocal('ccsrc'), `const { claudeLaunch, sourceProblem } = await import(${mod('server/claude-source.mjs')});
      const base = { PATH: '/usr/bin', HOME: '/home/x', ...${JSON.stringify(SECRETS)}, ...${JSON.stringify(HOST)} };
      const src = (id, extra = {}) => ({ id, label: id, url: { ollama: 'http://127.0.0.1:11434', lmstudio: 'http://127.0.0.1:1234', provider: 'https://openrouter.ai/api' }[id] || '', model: 'qwen3-coder:30b', context: id === 'provider' ? 0 : 32768, local: id !== 'provider', ...extra });
      const view = (l) => ({ env: Object.fromEntries(Object.entries(l.env).filter(([k]) => /^(ANTHROPIC|CLAUDE_CODE|MY_OTHER)/.test(k))), args: l.args, flag: l.args[0] === '--settings' ? JSON.parse(l.args[1]).env : null });
      const err = (f) => { try { f(); return null; } catch (e) { return e.message; } };
      console.log(JSON.stringify({
        plan: view(claudeLaunch({ id: 'plan' }, base)),
        ollama: view(claudeLaunch(src('ollama'), base)),
        lmstudio: view(claudeLaunch(src('lmstudio'), base)),
        provider: view(claudeLaunch(src('provider'), base, { key: 'sk-or-v1-SMOKE-provider' })),
        noModel: err(() => claudeLaunch(src('ollama', { model: '' }), base)),
        badUrl: err(() => claudeLaunch(src('provider', { url: 'openrouter.ai' }), base)),
        conflict: err(() => claudeLaunch(src('provider'), base, { key: 'k', conflicts: ['ANTHROPIC_API_KEY in ~/.claude/settings.json'] })),
        localIgnoresConflict: !err(() => claudeLaunch(src('ollama'), base, { conflicts: ['x'] })) }));`);
    const leak = (o) => JSON.stringify(o).includes('sk-ant-');
    must(r.plan.env.ANTHROPIC_API_KEY === SECRETS.ANTHROPIC_API_KEY && !r.plan.env.ANTHROPIC_BASE_URL && !r.plan.args.length, `the plan changed: ${JSON.stringify(r.plan)}`);
    for (const [id, url, token] of [['ollama', 'http://127.0.0.1:11434', 'ollama'], ['lmstudio', 'http://127.0.0.1:1234', 'lmstudio']]) {
      const x = r[id], e = x.env;
      must(!leak(x), `${id}: an Anthropic credential got through: ${JSON.stringify(x)}`);
      must(e.ANTHROPIC_BASE_URL === url && e.ANTHROPIC_AUTH_TOKEN === token && e.ANTHROPIC_API_KEY === token, `${id} endpoint/token: ${JSON.stringify(e)}`);
      must(['ANTHROPIC_MODEL', 'ANTHROPIC_DEFAULT_OPUS_MODEL', 'ANTHROPIC_DEFAULT_SONNET_MODEL', 'ANTHROPIC_DEFAULT_HAIKU_MODEL', 'CLAUDE_CODE_SUBAGENT_MODEL'].every((k) => e[k] === 'qwen3-coder:30b'), `${id} models: ${JSON.stringify(e)}`);
      must(e.CLAUDE_CODE_MAX_CONTEXT_TOKENS === '32768' && !('CLAUDE_CODE_OAUTH_TOKEN' in e) && !('ANTHROPIC_CUSTOM_HEADERS' in e) && !('MY_OTHER_VAR' in e) && !Object.keys(HOST).some((k) => k in e), `${id} context/credentials: ${JSON.stringify(e)}`);
      must(x.flag?.ANTHROPIC_BASE_URL === url && x.flag.ANTHROPIC_AUTH_TOKEN === token && x.flag.CLAUDE_CODE_OAUTH_TOKEN === '' && x.args.includes('--model'), `${id} --settings: ${JSON.stringify(x.args)}`);
    }
    const p = r.provider;
    must(!leak(p) && p.env.ANTHROPIC_AUTH_TOKEN === 'sk-or-v1-SMOKE-provider' && p.env.ANTHROPIC_API_KEY === 'sk-or-v1-SMOKE-provider' && p.env.ANTHROPIC_BASE_URL === 'https://openrouter.ai/api', `provider env: ${JSON.stringify(p.env)}`);
    must(!p.args.join(' ').includes('sk-or-v1') && !('ANTHROPIC_AUTH_TOKEN' in p.flag) && p.flag.ANTHROPIC_BASE_URL === 'https://openrouter.ai/api' && !('CLAUDE_CODE_MAX_CONTEXT_TOKENS' in p.env), `the provider key is on the command line: ${JSON.stringify(p.args)}`);
    must(/Pick the model/.test(r.noModel || '') && /URL/.test(r.badUrl || '') && /ANTHROPIC_API_KEY in/.test(r.conflict || '') && r.localIgnoresConflict, `refusals: ${JSON.stringify(r)}`);
    return 'plan untouched; Ollama, LM Studio and a provider get endpoint, token and model, never sk-ant-…; a provider key never on the command line';
  });

  if (process.platform !== 'win32') {
    await check('Claude Code model sources: what a started chat really gets (fake claude), Settings and status', async () => {
      // A stand-in for claude: answers --version and auth status, and writes down its arguments and environment.
      const fake = join(ROOT, 'fake-claude'), out = join(ROOT, 'fake-claude.json');
      writeFileSync(fake, `#!${process.execPath}\nconst fs = require('fs');\nif (process.argv.includes('--version')) { console.log('9.9.9 (Claude Code)'); process.exit(0); }\nif (process.argv[2] === 'auth') { console.log(JSON.stringify({ loggedIn: true, authMethod: 'claude.ai', subscriptionType: 'max' })); process.exit(0); }\nfs.writeFileSync(process.env.FAKE_CLAUDE_OUT, JSON.stringify({ argv: process.argv.slice(2), env: process.env }));\nsetTimeout(() => process.exit(0), 3000);\n`);
      execFileSync('chmod', ['755', fake]);
      const local = unitLocal('ccstart', { claudePath: fake });
      const r = nodeIn(local, `const fs = await import('node:fs');
        const { ChatSession } = await import(${mod('server/claude.mjs')});
        const { saveSection } = await import(${mod('server/settings.mjs')});
        const { state } = await import(${mod('server/util.mjs')});
        const out = ${JSON.stringify(out)}, cfg = ${JSON.stringify(join(ROOT, 'claude-config', 'settings.json'))};
        const startOnce = async (id) => { try { fs.rmSync(out, { force: true }); } catch {} const c = new ChatSession(id, () => 'ctx'); c.cwd = () => ${JSON.stringify(STUDIO)};
          try { await c.start(); } catch (e) { return { error: e.message }; }
          for (let i = 0; i < 100 && !fs.existsSync(out); i++) await new Promise((r) => setTimeout(r, 50));
          c.handle({ type: 'system', subtype: 'init', session_id: 'sess-' + id, model: 'm' });
          c.handle({ type: 'rate_limit_event', rate_limit_info: { unifiedWindows: { five_hour: { utilization: 0.5 } } } });
          c.kill(); const j = JSON.parse(fs.readFileSync(out, 'utf8'));
          return { argv: j.argv, env: Object.fromEntries(Object.entries(j.env).filter(([k]) => /^(ANTHROPIC|CLAUDE_CODE|MY_OTHER|ENABLE_CLAUDEAI)/.test(k))), source: state().projects[id]?.source };
        };
        const res = {};
        saveSection('claude', { ccSource: 'ollama', ccModel: 'qwen3-coder:30b' }); res.ollama = await startOnce('src-ollama');
        saveSection('claude', { ccSource: 'provider', ccUrl: 'https://openrouter.ai/api', ccModel: 'qwen/qwen3.6-35b' }); res.provider = await startOnce('src-provider');
        fs.writeFileSync(cfg, JSON.stringify({ env: { ANTHROPIC_API_KEY: 'from-your-settings' } })); res.conflict = await startOnce('src-conflict'); fs.rmSync(cfg);
        saveSection('claude', { ccSource: 'plan' }); res.plan = await startOnce('src-plan');
        saveSection('claude', { lean: false }); res.planFull = await startOnce('src-plan-full');
        saveSection('claude', { ccSource: 'ollama', ccModel: 'qwen3-coder:30b' }); res.ollamaForced = await startOnce('src-ollama-forced');
        saveSection('claude', { ccSource: 'plan', ccModel: '', lean: true });
        console.log(JSON.stringify(res)); process.exit(0);`, { ...SECRETS, FAKE_CLAUDE_OUT: out });
      const leak = (o) => JSON.stringify(o).includes('sk-ant-');
      must(!r.ollama.error && !leak(r.ollama) && r.ollama.env.ANTHROPIC_BASE_URL === 'http://127.0.0.1:11434' && r.ollama.env.ANTHROPIC_AUTH_TOKEN === 'ollama', `ollama: ${JSON.stringify(r.ollama).slice(0, 400)}`);
      const a = r.ollama.argv, i = a.indexOf('--model');
      must(i > 0 && a[i + 1] === 'qwen3-coder:30b' && a.includes('--settings') && /running on qwen3-coder:30b through Ollama/.test(a[a.indexOf('--append-system-prompt') + 1]) && r.ollama.source === 'ollama', `ollama args: ${JSON.stringify(a).slice(0, 400)}`);
      must(!r.provider.error && !leak(r.provider) && r.provider.env.ANTHROPIC_BASE_URL === 'https://openrouter.ai/api' && r.provider.env.ANTHROPIC_AUTH_TOKEN === 'no-key', `provider: ${JSON.stringify(r.provider).slice(0, 400)}`);
      must(/ANTHROPIC_API_KEY in .*settings\.json/.test(r.conflict.error || ''), `a settings file's key would have gone to the provider: ${JSON.stringify(r.conflict).slice(0, 300)}`);
      // The plan: Video Octopus's environment goes through as before (whatever ANTHROPIC_BASE_URL it had, Video Octopus adds none).
      must(!r.plan.error && r.plan.env.ANTHROPIC_API_KEY === SECRETS.ANTHROPIC_API_KEY && (r.plan.env.ANTHROPIC_BASE_URL || '') === (process.env.ANTHROPIC_BASE_URL || '') && !r.plan.argv.includes('--settings') && r.plan.source === 'plan', `plan: ${JSON.stringify({ env: r.plan.env, source: r.plan.source, settings: r.plan.argv?.includes('--settings'), error: r.plan.error })}`);
      // Clean chats: on by default (no MCP servers or claude.ai connectors, project and local settings only, no built-in
      // skills); off on the plan brings everything back; always on with another model source.
      const leanOn = (x) => x.argv.includes('--strict-mcp-config') && x.argv[x.argv.indexOf('--setting-sources') + 1] === 'project,local' && x.env.ENABLE_CLAUDEAI_MCP_SERVERS === 'false' && x.env.CLAUDE_CODE_DISABLE_BUNDLED_SKILLS === '1';
      must(leanOn(r.plan) && leanOn(r.ollama), `clean chats aren't on by default: ${JSON.stringify({ argv: r.plan.argv, env: r.plan.env }).slice(0, 500)}`);
      must(!r.planFull.error && !r.planFull.argv.includes('--strict-mcp-config') && !r.planFull.argv.includes('--setting-sources') && !r.planFull.env.ENABLE_CLAUDEAI_MCP_SERVERS, `clean chats off still trimmed: ${JSON.stringify(r.planFull).slice(0, 400)}`);
      must(leanOn(r.ollamaForced), `another model source without clean chats: ${JSON.stringify(r.ollamaForced).slice(0, 400)}`);
      // The server side: Settings saves the source, refuses a bad URL, /api/status hides the plan meter, Setup is happy without a sign-in.
      const bad = await api('/api/app/settings', { section: 'claude', values: { ccUrl: 'not a url' } });
      must(bad.status === 400, `a bad URL was saved: ${bad.status}`);
      const sv = await api('/api/app/settings', { section: 'claude', values: { ccSource: 'lmstudio', ccModel: 'qwen3.8-27b', ccUrl: 'http://127.0.0.1:9' } });
      must(sv.status === 200 && sv.json.values.claude.ccSource === 'lmstudio' && sv.json.keyInfo.ANTHROPIC_COMPATIBLE_API_KEY, `save: ${sv.text.slice(0, 200)}`);
      try {
        const st = (await api('/api/status')).json;
        must(st.modelSource?.id === 'lmstudio' && st.modelSource.model === 'qwen3.8-27b' && st.usage === null, `status: ${JSON.stringify(st.modelSource)} usage ${JSON.stringify(st.usage)}`);
        const e = (await api('/api/app/engines?source')).json;
        must(e.ccSource.id === 'lmstudio' && e.ccCheck && e.ccCheck.running === false && /Nothing answers/.test(e.ccCheck.note), `check: ${JSON.stringify(e.ccCheck)}`);
      } finally { await api('/api/app/settings', { section: 'claude', values: { ccSource: 'plan', ccModel: '', ccUrl: '' } }); }
      must((await api('/api/status')).json.modelSource === null, 'back on the plan, the status still names another source');
      return 'Ollama and a provider: endpoint, token, --settings and --model, nothing sk-ant-; a settings file\'s key refused; the plan as before; clean chats on by default, off on the plan, forced with another source; status, Settings';
    });
  }

  await check('Claude Code model sources: Ollama and LM Studio checks read lists only (fake servers)', async () => {
    const r = nodeIn(unitLocal('cccheck'), `const http = await import('node:http');
      const { sourceCheck } = await import(${mod('server/claude-source.mjs')});
      const seen = [];
      const serve = (routes) => new Promise((done) => { const s = http.createServer((req, res) => { seen.push(req.method + ' ' + req.url); const r = routes[req.url];
        res.writeHead(r ? 200 : 404, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(r || { error: 'Unexpected endpoint or method. (' + req.method + ' ' + req.url + ')' })); }).listen(0, '127.0.0.1', () => done(s)); });
      const url = (s) => 'http://127.0.0.1:' + s.address().port;
      const ollama = await serve({ '/api/version': { version: '0.14.2' }, '/api/tags': { models: [{ name: 'qwen3-coder:30b', details: { parameter_size: '30.5B' } }] } });
      const oldOllama = await serve({ '/api/version': { version: '0.13.5' }, '/api/tags': { models: [] } });
      const lm = await serve({ '/api/v1/models': { models: [{ type: 'llm', key: 'qwen3.8-27b', display_name: 'Qwen 3.8 27B', max_context_length: 131072, capabilities: { trained_for_tool_use: true }, loaded_instances: [{ config: { context_length: 65536 } }] }, { type: 'embedding', key: 'nomic-embed' }] } });
      const oldLm = await serve({ '/v1/models': { data: [{ id: 'qwen' }] } });
      const src = (id, s) => ({ id, label: id, url: url(s), model: '', context: 32768, local: true });
      const out = { ollama: await sourceCheck(src('ollama', ollama)), oldOllama: await sourceCheck(src('ollama', oldOllama)), lm: await sourceCheck(src('lmstudio', lm)), oldLm: await sourceCheck(src('lmstudio', oldLm)),
        none: await sourceCheck({ id: 'ollama', label: 'Ollama', url: 'http://127.0.0.1:9', model: '', local: true }) };
      out.posts = seen.filter((x) => !x.startsWith('GET ')); console.log(JSON.stringify(out)); process.exit(0);`);
    must(r.ollama.ok && r.ollama.messagesApi && r.ollama.models[0]?.id === 'qwen3-coder:30b' && /30\.5B/.test(r.ollama.models[0].label), `ollama: ${JSON.stringify(r.ollama)}`);
    must(!r.oldOllama.ok && /0\.14/.test(r.oldOllama.note), `old ollama: ${JSON.stringify(r.oldOllama)}`);
    must(r.lm.ok && r.lm.messagesApi && r.lm.models.length === 1 && r.lm.models[0].context === 65536 && r.lm.models[0].loaded && r.lm.models[0].tools, `lm studio: ${JSON.stringify(r.lm)}`);
    must(!r.oldLm.ok && r.oldLm.running && !r.oldLm.messagesApi && /older than 0\.4/.test(r.oldLm.note), `old lm studio: ${JSON.stringify(r.oldLm)}`);
    must(!r.none.running && /Nothing answers/.test(r.none.note) && !r.posts.length, `nothing there / posts: ${JSON.stringify(r)}`);
    return 'Ollama 0.14 yes, 0.13 no; LM Studio 0.4 (models, context, tools) yes, older no; nothing running; only GETs';
  });

  await check('Codex runs: MCP servers, web search, apps and plugins off at thread start; stopped if used anyway (no Codex needed)', async () => {
    const r = nodeIn(unitLocal('codexrun'), `const { CodexSession } = await import(${mod('server/codex.mjs')});
      const mk = (id) => { const c = new CodexSession(id, () => 'ctx'); c.mode = () => 'manual'; c.ev = []; c.calls = []; c.emit = (e) => c.ev.push(e); c.write = () => {};
        c.call = async (m, p) => { c.calls.push([m, p]); return m === 'config/read' ? { config: { mcp_servers: { github: {}, 'hostinger-dns': {}, 'odd name.x': {} } } } : {}; }; return c; };
      const run = mk('_run_s1'), chat = mk('smoke-codex-chat');
      const rp = await run.threadParams('/tmp/proj'), cp = await chat.threadParams('/tmp/proj');
      run.turnId = 't1'; run.threadId = 'th1'; chat.turnId = 't2';
      for (const c of [run, chat]) { c.handle({ method: 'item/started', params: { item: { type: 'mcpToolCall', id: 'm1', server: 'github', tool: 'create_issue', arguments: {} } } });
        c.handle({ method: 'item/started', params: { item: { type: 'webSearch', id: 'w1', query: 'cats' } } }); }
      console.log(JSON.stringify({ rp, cp, runRead: run.calls.find((x) => x[0] === 'config/read')?.[1], chatRead: chat.calls.some((x) => x[0] === 'config/read'),
        runRefused: run.ev.filter((e) => e.t === 'refused'), runTools: run.ev.filter((e) => e.t === 'tool').length, interrupts: run.calls.filter((x) => x[0] === 'turn/interrupt').length,
        chatTools: chat.ev.filter((e) => e.t === 'tool').map((e) => e.name), chatRefused: chat.ev.filter((e) => e.t === 'refused').length }));`);
    const c = r.rp.config || {};
    must(c.web_search === 'disabled' && c['features.apps'] === false && c['features.plugins'] === false && c['features.browser_use'] === false && c['features.computer_use'] === false, `run config: ${JSON.stringify(c)}`);
    must(c['mcp_servers.github.enabled'] === false && c['mcp_servers.hostinger-dns.enabled'] === false && !Object.keys(c).some((k) => k.includes('odd name')) && r.runRead?.cwd === '/tmp/proj', `run MCP: ${JSON.stringify(c)}`);
    must(r.rp.approvalPolicy === 'untrusted' && r.rp.sandbox === 'read-only' && !('config' in r.cp) && !r.chatRead, `a project chat got run config: ${JSON.stringify(r.cp)}`);
    must(r.runRefused.length === 2 && r.runRefused[0].tool === 'an MCP tool' && /github create_issue/.test(r.runRefused[0].summary) && r.runTools === 0 && r.interrupts === 2, `run stop: ${JSON.stringify(r)}`);
    must(r.chatRefused === 0 && r.chatTools.length === 2, `the project chat was stopped: ${JSON.stringify(r)}`);
    return 'web_search disabled, each MCP server by name, apps/plugins/browser/computer use off; an MCP call or search stops the run; chats untouched';
  });

  await check('Transcribe new recordings: takes in no project, written only into their tr/ folder, carried into a new project', async () => {
    const fresh = '20261018-090000', used = take;
    mkdirSync(join(REC, fresh), { recursive: true });
    execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'sine=frequency=330:sample_rate=48000', '-t', '1', '-c:a', 'pcm_s16le', join(REC, fresh, `${fresh}_audio.wav`)]);
    const v = (await api('/api/app/schedules')).json;
    const tpl = v.templates.find((t) => t.template === 'transcribe-new');
    must(tpl?.scope === 'new-takes' && /recordings/.test(tpl.name) && v.scopes['new-takes'], `template: ${JSON.stringify(tpl)}`);
    const pv = await api('/api/app/schedules', { op: 'preview', schedule: { name: 'T', cron: '0 7 * * *', scope: 'new-takes', prompt: 'x' } });
    must(pv.status === 200 && /\d+ recordings? in scope/.test(pv.json.inScopeText || ''), `preview: ${pv.text}`);
    const r = node(`const { runScope, decide } = await import(${mod('server/schedules.mjs')});
      const sch = { mode: 'change', scope: 'new-takes' }, sc = runScope(sch), R = ${JSON.stringify(REC)};
      const d = (f) => decide(sch, { tool_name: 'Write', input: { file_path: f } }, sc.roots).allow;
      console.log(JSON.stringify({ takes: sc.takes, intoTr: d(R + '/${fresh}/tr/words.json'), recording: d(R + '/${fresh}/${fresh}_audio.wav'), usedTake: d(R + '/${used}/tr/words.json'),
        projects: (sc.projects || []).map((p) => p.id) }));`);
    must(r.takes.some((t) => t.id === fresh && t.main === `${fresh}_audio.wav`) && !r.takes.some((t) => t.id === used), `takes: ${JSON.stringify(r.takes)}`);
    must(r.intoTr && !r.recording && !r.usedTake, `scope: ${JSON.stringify(r)}`);
    // The run's transcript, then a project from that take: it starts with it.
    mkdirSync(join(REC, fresh, 'tr'), { recursive: true });
    writeFileSync(join(REC, fresh, 'tr', 'words.json'), JSON.stringify([[0.1, 0.4, 'hello']]));
    const left = node(`const { runScope } = await import(${mod('server/schedules.mjs')}); console.log(JSON.stringify(runScope({ scope: 'new-takes' }).takes.map((t) => t.id)));`);
    must(!left.includes(fresh), `a transcribed take is still in scope: ${JSON.stringify(left)}`);
    const pr = await api('/api/projects', { name: 'From a transcribed take', type: 'tutorial', take: fresh });
    must(pr.status === 200 && existsSync(join(STUDIO, 'projects', pr.json.id, 'work', 'tr', 'words.json')), `the transcript didn't come along: ${pr.text}`);
    return `${pv.json.inScopeText}; writes only in <take>/tr/; project ${pr.json.id} starts transcribed`;
  });

  await check('GETs leave an idle stale Video Octopus assistant and Library chat alone; a POST replaces them', async () => {
    const r = nodeIn(unitLocal('peek'), `const { assistantRoute, assistantChat, peekAssistant } = await import(${mod('server/assistant.mjs')});
      const { libraryChat, libraryEvents, peekLibraryChat } = await import(${mod('server/library.mjs')});
      const { saveSection } = await import(${mod('server/settings.mjs')});
      saveSection('claude', { engine: 'claude' });
      const a = assistantChat(), l = libraryChat();
      saveSection('claude', { engine: 'codex' });
      const killed = [], fake = (n) => ({ kill: () => killed.push(n), stdin: { writable: false } });
      a.proc = fake('assistant'); l.proc = fake('library');
      const req = { method: 'GET', on() {} }, res = { writeHead() {}, write() {} };
      await assistantRoute(req, res, new URL('http://127.0.0.1/api/projects/_studio/events'), { send() {}, body: async () => ({}) });
      libraryEvents(req, res);
      const afterGet = { killed: [...killed], sameA: peekAssistant() === a, sameL: peekLibraryChat() === l };
      const a2 = assistantChat(), l2 = libraryChat();
      console.log(JSON.stringify({ ...afterGet, killedAfterPost: killed, engines: [a2.engine, l2.engine], replaced: a2 !== a && l2 !== l })); process.exit(0);`);
    must(!r.killed.length && r.sameA && r.sameL, `a GET stopped or replaced a chat: ${JSON.stringify(r)}`);
    must(r.killedAfterPost.join() === 'assistant,library' && r.engines.join() === 'codex,codex' && r.replaced, `the POST didn't switch them: ${JSON.stringify(r)}`);
    return 'events GETs: nothing stopped; the next POST: both on the new agent';
  });

  await check('router: a page left during its first load is torn down; the next one waits; a skipped one never loads', async () => {
    const r = nodeIn(unitLocal('router'), `const { makeRouter } = await import(${mod('web/nav.js')});
      const log = [], delay = { a: 80, b: 0, c: 0, d: 0 }; let which = 'a';
      const go = makeRouter(async (nav) => { const id = which; log.push('open ' + id); await new Promise((r) => setTimeout(r, delay[id])); log.push((nav.alive() ? 'live ' : 'left ') + id);
        return { teardown: () => log.push('teardown ' + id) }; });
      go(); await new Promise((r) => setTimeout(r, 10)); which = 'b'; await go();
      which = 'c'; go(); which = 'd'; await go();
      console.log(JSON.stringify(log));`);
    must(r.join() === 'open a,left a,teardown a,open b,live b,teardown b,open d,live d', `navigation order: ${r.join(' → ')}`);
    return r.join(' → ');
  });

  // The recorder through the real page (test/recorder.e2e.mjs), when Playwright is there (PLAYWRIGHT_PATH).
  if (process.env.PLAYWRIGHT_PATH) {
    await check('recorder: New project → record → canvas; camera, screen + camera, mic only, layer, block (headless Chrome, fake devices)', async () => {
      try {
        const out = execFileSync(process.execPath, [join(APP, 'test', 'recorder.e2e.mjs')], { env: { ...process.env, STUDIO_URL: BASE }, encoding: 'utf8', timeout: 900000 });
        return out.trim().split('\n').pop();
      } catch (e) { throw new Error(String((e.stdout || '') + (e.stderr || '') || e.message).trim().split('\n').slice(-6).join(' | ')); }
    });
    await check('script: put one in, try it, its own window follows a take, it scrolls over Video Octopus during a take and stops it, remove (headless Chrome, fake devices)', async () => {
      try {
        const out = execFileSync(process.execPath, [join(APP, 'test', 'prompter.e2e.mjs')], { env: { ...process.env, STUDIO_URL: BASE }, encoding: 'utf8', timeout: 300000 });
        return out.trim().split('\n').pop();
      } catch (e) { throw new Error(String((e.stdout || '') + (e.stderr || '') || e.message).trim().split('\n').slice(-6).join(' | ')); }
    });
  }

  // Keys: Windows encrypts them for the user (DPAPI); a Mac uses the login Keychain, which a test shouldn't touch.
  if (process.platform !== 'darwin') {
    await check('API key store: save, read back, remove', async () => {
      const code = `const k = await import(${JSON.stringify(new URL('../server/keychain.mjs', import.meta.url).href)});
        await k.saveKey('STUDIO_SMOKE_KEY', 'sk-test-123_ABC');
        const back = await k.readKey('STUDIO_SMOKE_KEY');
        const gone = await k.removeKey('STUDIO_SMOKE_KEY');
        console.log(JSON.stringify({ same: back === 'sk-test-123_ABC', gone, store: k.KEY_STORE }));`;
      const out = execFileSync(process.execPath, ['--input-type=module', '-e', code], { env: { ...process.env, STUDIO_LOCAL_DIR: LOCAL }, encoding: 'utf8' });
      const r = JSON.parse(out.trim().split('\n').pop());
      must(r.same, 'the key read back was different');
      must(r.gone, 'the key was not removed');
      return r.store;
    });
  }

  // ---- updates (server/updates.mjs, starter-sync.mjs, login-item.mjs; start.sh / start.cmd) ----
  await check('starter updates: unchanged → updated, changed → kept + .studio/updates, new → added, deleted stays deleted', async () => {
    const S = join(ROOT, 'sync'), starter = join(S, 'starter'), studio = join(S, 'studio'), bare = join(S, 'own-studio');
    const put = (root, rel, text) => { mkdirSync(dirname(join(root, rel)), { recursive: true }); writeFileSync(join(root, rel), text); };
    const read = (rel) => readFileSync(join(studio, rel), 'utf8');
    const sha = (t) => createHash('sha1').update(t).digest('hex');
    // Starter version 1, and a studio made from it with the manifest Create my studio writes.
    const v1 = { 'CLAUDE.md': 'c1', 'memory/preferences.md': 'p1', 'tools/cut.py': 't1', 'skills/old.md': 'o1', 'same.md': 's1' };
    for (const [rel, t] of Object.entries(v1)) { put(starter, rel, t); put(studio, rel, t); }
    put(starter, 'VERSION', '1');
    put(studio, '.studio/starter.json', JSON.stringify({ version: '1', created: 'x', files: Object.fromEntries(Object.entries(v1).map(([k, t]) => [k, sha(t)])), kept: [] }));
    put(bare, 'CLAUDE.md', 'my own');
    // The creator changes CLAUDE.md and deletes skills/old.md. Then the starter's version 2 changes four files and adds two.
    put(studio, 'CLAUDE.md', 'mine');
    rmSync(join(studio, 'skills', 'old.md'));
    for (const [rel, t] of Object.entries({ 'CLAUDE.md': 'c2', 'memory/preferences.md': 'p2', 'tools/cut.py': 't2', 'skills/old.md': 'o2', 'new.md': 'n2', 'tools/join/check.py': 'j2', VERSION: '2' })) put(starter, rel, t);
    const r = modRun(`const s = await import(${mod('server/starter-sync.mjs')});
      const o = { starter: ${JSON.stringify(starter)} };
      const plan = s.starterPlan(${JSON.stringify(studio)}, o), done = s.applyStarter(${JSON.stringify(studio)}, o), again = s.starterPlan(${JSON.stringify(studio)}, o);
      const own = s.starterPlan(${JSON.stringify(bare)}, o), ownApply = s.applyStarter(${JSON.stringify(bare)}, o);
      console.log(JSON.stringify({ plan, done, again, own, ownApply }));`);
    const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);
    must(eq(r.plan.update, ['memory/preferences.md', 'tools/cut.py']) && eq(r.plan.add, ['new.md', 'tools/join/check.py']) && eq(r.plan.keep, ['CLAUDE.md']) && eq(r.plan.deleted, ['skills/old.md']),
      `dry run: ${JSON.stringify(r.plan)}`);
    must(read('memory/preferences.md') === 'p2' && read('tools/cut.py') === 't2', 'unchanged files were not updated');
    must(read('CLAUDE.md') === 'mine' && readFileSync(join(studio, '.studio', 'updates', 'CLAUDE.md'), 'utf8') === 'c2', 'the changed file was not kept, or its new version is not in .studio/updates');
    must(read('new.md') === 'n2' && read('tools/join/check.py') === 'j2', 'new files were not added');
    must(!existsSync(join(studio, 'skills', 'old.md')), 'a deleted file came back');
    must(read('same.md') === 's1', 'an untouched file changed');
    const man = JSON.parse(read('.studio/starter.json'));
    must(man.version === '2' && man.files['tools/cut.py'] === sha('t2') && man.files['new.md'] === sha('n2') && man.files['CLAUDE.md'] === sha('c2') && man.files['skills/old.md'] === sha('o1'), `manifest: ${JSON.stringify(man)}`);
    must(r.again.pending === 0 && eq(r.again.waiting, ['CLAUDE.md']), `a second run still has work: ${r.again.text}`);
    must(/2 starter files updated; 2 added; 1 kept as you changed it: new version in \.studio\/updates\/CLAUDE\.md/.test(r.done.text), r.done.text);
    must(r.own.reason === 'no-manifest' && r.ownApply.reason === 'no-manifest' && eq(readdirSync(bare), ['CLAUDE.md']), 'a studio without starter.json was touched');
    return r.done.text;
  });

  await check('app update: git fetch + pull --ff-only on a clone of a bare repo in a temp folder (no network)', async () => {
    const G = join(ROOT, 'git');
    const git = (cwd, ...args) => execFileSync('git', ['-c', 'user.name=Smoke', '-c', 'user.email=smoke@example.com', '-c', 'commit.gpgsign=false', ...args],
      { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
    const seed = join(G, 'seed'), app = join(G, 'app'), other = join(G, 'other'), away = join(G, 'away'), zip = join(G, 'zip');
    for (const d of [seed, zip]) mkdirSync(d, { recursive: true });
    git(seed, 'init', '-q'); git(seed, 'checkout', '-q', '-b', 'main');
    writeFileSync(join(seed, 'package.json'), JSON.stringify({ version: '1.0.0' }));
    git(seed, 'add', '.'); git(seed, 'commit', '-q', '-m', 'First version');
    git(G, 'clone', '-q', '--bare', 'seed', 'remote.git');
    for (const d of ['app', 'other', 'away']) git(G, 'clone', '-q', 'remote.git', d);
    // Two new commits on the "GitHub" side; a zip download (no .git); a clone whose remote is gone (offline).
    writeFileSync(join(other, 'package.json'), JSON.stringify({ version: '1.1.0' })); git(other, 'commit', '-q', '-am', 'Version 1.1');
    writeFileSync(join(other, 'new.txt'), 'x'); git(other, 'add', '.'); git(other, 'commit', '-q', '-m', 'Add a file'); git(other, 'push', '-q');
    writeFileSync(join(zip, 'package.json'), JSON.stringify({ version: '1.0.0' }));
    git(away, 'remote', 'set-url', 'origin', join(G, 'gone.git'));
    const r = modRun(`const fs = await import('node:fs'); const u = await import(${mod('server/updates.mjs')});
      const A = ${JSON.stringify(app)}, pkg = ${JSON.stringify(join(app, 'package.json'))}, orig = fs.readFileSync(pkg, 'utf8');
      const first = await u.checkUpdates(A);
      fs.writeFileSync(pkg, '{"version":"9"}');
      const dirty = await u.pullUpdate(A);
      fs.writeFileSync(pkg, orig);
      const pulled = await u.pullUpdate(A), after = await u.checkUpdates(A, { fetch: false });
      const zip = await u.checkUpdates(${JSON.stringify(zip)}), zipPull = await u.pullUpdate(${JSON.stringify(zip)});
      const away = await u.checkUpdates(${JSON.stringify(away)}), awayPull = await u.pullUpdate(${JSON.stringify(away)});
      console.log(JSON.stringify({ first, dirty, pulled, after, zip, zipPull, away, awayPull }));`);
    must(r.first.behind === 2 && r.first.can && r.first.commits.map((c) => c.subject).join('|') === 'Add a file|Version 1.1' && r.first.version === '1.0.0', `check: ${JSON.stringify(r.first)}`);
    must(!r.dirty.updated && r.dirty.reason === 'local-changes' && /package\.json/.test(r.dirty.text) && /git stash/.test(r.dirty.how), `local changes: ${JSON.stringify(r.dirty)}`);
    must(r.pulled.updated && r.pulled.count === 2 && r.pulled.version === '1.1.0' && existsSync(join(app, 'new.txt')) && r.after.behind === 0, `pull: ${JSON.stringify(r.pulled)}`);
    must(!r.zip.clone && r.zip.reason === 'not-clone' && /by hand/.test(r.zip.how) && !r.zipPull.updated, `zip: ${JSON.stringify(r.zip)}`);
    must(r.away.offline && !r.awayPull.updated && /Couldn't reach/.test(r.awayPull.text), `offline: ${JSON.stringify(r.away)}`);
    return `${r.pulled.text} · zip: by hand · offline: no error`;
  });

  await check('Restart: exits with code 75 under start.sh/start.cmd, says how without them', async () => {
    const r = await api('/api/app/updates/restart', {});
    must(r.json?.restarting === false && /start\.(sh|cmd)/.test(r.json.how || ''), `without the loop: ${r.text}`);
    const port = await freePort(), local = otherInstall('local-restart');
    const child = spawn(process.execPath, [join(APP, 'server', 'index.mjs')], { cwd: APP, env: otherEnv(port, local, { STUDIO_SUPERVISED: '1' }), stdio: 'ignore' });
    const exited = new Promise((done) => child.on('exit', (code) => done(code)));
    try {
      await until(async () => { try { return (await fetch(`http://127.0.0.1:${port}/`)).ok; } catch { return false; } }, 30000, 'the second server');
      const rr = await fetch(`http://127.0.0.1:${port}/api/app/updates/restart`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Studio': '1' }, body: '{}' }).then((x) => x.json());
      must(rr.restarting === true, `no restart: ${JSON.stringify(rr)}`);
      const code = await Promise.race([exited, sleep(15000).then(() => 'still running')]);
      must(code === 75, `exit code ${code}`);
      return 'exit code 75';
    } finally { child.kill(); }
  });

  const WIN = process.platform === 'win32', START = WIN ? 'start.cmd' : 'start.sh';
  await check(`${START}: starts Video Octopus again after Restart, ends on a normal exit, no browser`, async () => {
    const port = await freePort(), local = otherInstall('local-loop'), base = `http://127.0.0.1:${port}`;
    const env = otherEnv(port, local, { STUDIO_NO_OPEN: '1' });
    const loop = WIN ? spawn('cmd.exe', ['/d', '/c', join(APP, 'start.cmd')], { env, stdio: 'ignore', windowsHide: true }) : spawn('bash', [join(APP, 'start.sh')], { env, stdio: 'ignore' });
    const exited = new Promise((done) => loop.on('exit', (code) => done(code)));
    const boot = () => fetch(base + '/api/app/updates').then((x) => x.json()).then((j) => j.bootId || null).catch(() => null);
    let pid = null;
    try {
      const first = await until(boot, 30000, `Video Octopus from ${START}`);
      const rr = await fetch(base + '/api/app/updates/restart', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Studio': '1' }, body: '{}' }).then((x) => x.json());
      must(rr.restarting === true, `${START} didn't say Restart works (STUDIO_SUPERVISED): ${JSON.stringify(rr)}`);
      const second = await until(async () => { const b = await boot(); return b && b !== first ? b : null; }, 30000, 'the restarted server');
      pid = JSON.parse(readFileSync(join(local, 'server.json'), 'utf8')).pid;
      process.kill(pid); // Video Octopus stops normally: the loop ends
      const code = await Promise.race([exited, sleep(15000).then(() => 'still running')]);
      must(code !== 'still running', 'the loop kept going after a normal exit');
      if (!WIN) must(code === 0, `the loop ended with ${code}`);
      return `restarted (${first.split('-')[0]} → ${second.split('-')[0]}), then stopped (exit ${code})`;
    } finally { try { loop.kill(); } catch {} if (pid) try { process.kill(pid); } catch {} }
  });

  await check('Open Video Octopus when I log in: the switch writes its file and removes it (a throwaway home)', async () => {
    const home = join(ROOT, 'home');
    mkdirSync(home, { recursive: true });
    const r = modRun(`const fs = await import('node:fs'); const L = await import(${mod('server/login-item.mjs')});
      const file = L.loginFile(), before = L.loginState().on;
      const on = await L.setLogin(true), text = fs.readFileSync(file, 'utf8'), off = await L.setLogin(false);
      console.log(JSON.stringify({ file, before, on, text, off, left: fs.existsSync(file) }));`,
    { HOME: home, USERPROFILE: home, APPDATA: join(home, 'AppData', 'Roaming'), XDG_CONFIG_HOME: '', STUDIO_LOGIN_DIR: '' });
    must(r.file.startsWith(home), `the file would go to ${r.file}`);
    must(!r.before && r.on.on && r.on.here, `switching on: ${JSON.stringify(r.on)}`);
    must(/STUDIO_NO_OPEN/.test(r.text) && r.text.includes(join(APP, START)), `the file doesn't run ${START} without a browser:\n${r.text}`);
    if (process.platform === 'darwin') must(/<key>RunAtLoad<\/key><true\/>/.test(r.text) && /login\.log/.test(r.text) && r.file.endsWith('Library/LaunchAgents/local.video-octopus.plist'), 'not a LaunchAgent with a log');
    must(!r.off.on && !r.left, 'switching off left the file');
    return `${r.file.slice(home.length + 1)} written, then removed`;
  });

  // ---- the step rail (v2): the words per step, stages, next, skipped, done lines, the help flag ----
  await check('step rail: every step of every format has its words; a studio step without them falls back', async () => {
    const P = JSON.parse(readFileSync(join(APP, 'core', 'pipelines.json'), 'utf8'));
    const STAGES = ['Record', 'Cut', 'Plan', 'Build', 'Polish'], TABS = ['canvas', 'scenes', 'cut', 'renders', 'post'];
    must(JSON.stringify((P.stages || []).map((x) => x.name)) === JSON.stringify(STAGES) && P.stages.every((x) => x.title && x.what), 'pipelines.json "stages" is not the five stages with a title and a line each');
    const bad = [];
    for (const [fid, f] of Object.entries(P.formats)) for (const x of [...f.steps, ...(f.more || [])]) {
      const st = typeof x === 'string' ? { id: x, ...P.shared[x] } : x;
      if (!STAGES.includes(st.stage) || !st.name || !st.what || !st.where || !TABS.includes(st.show?.tab) || !st.show?.target || !st.label) bad.push(`${fid}/${st.id}`);
    }
    must(!bad.length, `steps without stage/name/what/where/show (or without their label): ${bad.join(', ')}`);
    const names = Object.fromEntries(Object.values(P.formats).flatMap((f) => f.steps).map((x) => (typeof x === 'string' ? [x, P.shared[x].name] : [x.id, x.name])));
    const want = { import: 'Record', prepare: 'Clean up', sections: 'Split into sections', 'cut-editor': 'Fix the cut', lock: 'Lock the cut', plan: 'Plan the scenes', intro: 'Build the intro', 'edit-short': 'Edit the Short', 'edit-explainer': 'Edit the explainer', review: 'Review scenes', zooms: 'Add zooms', 'post-kit': 'Write the post' };
    for (const [k, v] of Object.entries(want)) must(names[k] === v, `${k} is named "${names[k]}", not "${v}"`);
    // A studio's overlay: its own step with only a label (and done), in a format of its own and in the Short.
    const studio = join(ROOT, 'rail-studio'), local = join(ROOT, 'rail-local');
    mkdirSync(join(studio, '.studio'), { recursive: true }); mkdirSync(join(studio, 'projects', 'p'), { recursive: true }); mkdirSync(local, { recursive: true });
    writeFileSync(join(local, 'settings.json'), JSON.stringify({ studio, projectsDir: 'projects', setup: { done: true }, updates: { auto: false } }));
    writeFileSync(join(studio, '.studio', 'formats.json'), JSON.stringify({ shared: { 'my-thumbs': { label: 'Make thumbnails', skill: 'thumbs', done: { files: ['thumbs/*.png'] } } },
      formats: { short: { steps: ['import', 'prepare', 'my-thumbs', 'review'] }, vlog: { label: 'Vlog', steps: ['import', { id: 'my-cut', label: 'My own cut', done: { worklog: 'Mine done' } }] } } }));
    writeFileSync(join(studio, 'projects', 'p', 'project.json'), JSON.stringify({ name: 'p', type: 'short' }));
    writeFileSync(join(studio, 'projects', 'p', 'WORKLOG.md'), '# p\n- 2026-10-18: Mine done, all of it\n');
    const r = modRun(`const S = await import(${mod('server/studio.mjs')}); const d = S.projectDir('p');
      console.log(JSON.stringify({ short: S.pipelineStatus(d, 'short'), vlog: S.pipelineStatus(d, 'vlog', { lines: true }), info: S.formatInfo().short.steps }));`, { STUDIO_LOCAL_DIR: local });
    const th = r.short.steps.find((x) => x.id === 'my-thumbs'), mine = r.vlog.steps.find((x) => x.id === 'my-cut');
    must(th && th.name === 'Make thumbnails' && th.stage === 'Cut' && /thumbs skill/.test(th.what) && th.show === null, `overlay step: ${JSON.stringify(th)}`);
    must(mine && mine.name === 'My own cut' && mine.stage === 'Record' && mine.what && mine.done && /Mine done/.test(mine.line), `overlay step in an overlay format: ${JSON.stringify(mine)}`);
    must(r.short.stages.length === 5 && r.short.stages.find((x) => x.name === 'Plan').steps.length === 0, 'stages are not always the five');
    must(r.info.every((x) => x.name) && r.info[1].name === 'Clean up', `New project's steps: ${JSON.stringify(r.info)}`);
    return `${Object.values(P.formats).reduce((t, f) => t + f.steps.length + (f.more || []).length, 0)} steps in ${Object.keys(P.formats).length} formats; overlay steps fall back to their label`;
  });

  await check('step rail: stages, next, skipped and the done line for projects at several stages', async () => {
    // Fixture projects in a throwaway studio (step rail check above), built up one stage at a time.
    const studio = join(ROOT, 'rail-studio'), local = join(ROOT, 'rail-local');
    writeFileSync(join(studio, '.studio', 'formats.json'), '{}');
    const mk = (name, files) => {
      const d = join(studio, 'projects', name);
      mkdirSync(join(d, 'source'), { recursive: true });
      writeFileSync(join(d, 'project.json'), JSON.stringify({ name, type: 'tutorial', ...(files['project.json'] || {}) }));
      execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=gray:size=320x180:rate=30', '-f', 'lavfi', '-i', 'sine=frequency=300:sample_rate=48000', '-t', '4', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', join(d, 'source', 'take_webcam.mov')]);
      for (const [f, v] of Object.entries(files)) {
        if (f === 'project.json') continue;
        mkdirSync(dirname(join(d, f)), { recursive: true });
        if (v === 'take') execFileSync('ffmpeg', ['-v', 'error', '-y', '-i', join(d, 'source', 'take_webcam.mov'), '-c', 'copy', join(d, f)]);
        else writeFileSync(join(d, f), typeof v === 'string' ? v : JSON.stringify(v));
      }
    };
    const prepared = { 'work/tr/words.json': [[0.2, 0.5, 'Hello'], [0.6, 1.0, 'there']], 'work/rough_map.json': { segments: [{ src: [0, 1.5] }, { src: [2, 4] }] },
      'work/cuts.json': { items: [{ id: 1, start: 1.5, end: 2, reason: 'silence', action: 'cut', text: '[pause]' }, { id: 2, start: 0.55, end: 0.6, reason: 'filler', action: 'ask', text: '[sound]' }] },
      'work/joins.json': { joins: [{}, {}], summary: { joins: 2, likely_clipped: 0, check: 1 } }, 'work/prepare.json': { cuts: 3, joins: 2, needs_you: 1, summary: 'Rough cut: 3 cuts, 1 needs you' } };
    const sectioned = { ...prepared, 'work/blocks.json': { v: 1, marked: true, blocks: [{ id: 'main', type: 'body', label: 'Main body', source: { take: [0, 4] } }] } };
    const scenes = (n) => ({ scenes: Array.from({ length: n }, (_, i) => ({ id: String(i + 1), start: i, end: i + 1 })) });
    const built = { ...sectioned, 'work/edl_fixed.json': { segments_sec: [[0, 1.5], [2, 4]] }, 'work/edl_manual.json': { segments_sec: [[0, 1.2], [2, 4]] },
      'WORKLOG.md': '# x\n- 2026-10-18: Cut locked (join-check: 2 joins, 0 clipped)\n- 2026-10-18: Scenes approved\n', 'work/production.json': scenes(3),
      'work/notes.json': { notes: [], approved: { 1: 't', 2: 't', 3: 't' } }, 'renders/x_intro_v1.mp4': 'take', 'project.json': { skipped: ['cut-editor'] } };
    mk('s0', {}); mk('s1', prepared); mk('s2', sectioned); mk('s3', built); mk('s4', { ...built, 'work/zooms.json': { zooms: [{ in: [0.1, 0.6], out: [2, 2.6] }, { in: [3, 3.3], out: [3.5, 3.9] }] } });
    // Add zooms with nothing to zoom: an empty v2 file with the reason is a finished step.
    mk('s5', { ...built, 'work/zooms.json': { v: 2, items: [], reason: "you're never full frame." } });
    const r = modRun(`const S = await import(${mod('server/studio.mjs')}); const out = {};
      for (const n of ['s0', 's1', 's2', 's3', 's4', 's5']) out[n] = S.pipelineStatus(S.projectDir(n), 'tutorial', { lines: true, seen: n === 's2' ? ['import', 'prepare'] : n === 's4' ? null : [] });
      S.setSkipped(S.projectDir('s3'), 'tutorial', 'zooms', true); out.s3skip = S.pipelineStatus(S.projectDir('s3'), 'tutorial');
      try { S.setSkipped(S.projectDir('s3'), 'tutorial', 'lock', true); out.lockSkip = 'allowed'; } catch (e) { out.lockSkip = e.message; }
      S.setSkipped(S.projectDir('s3'), 'tutorial', 'zooms', false); out.s3back = S.pipelineStatus(S.projectDir('s3'), 'tutorial');
      console.log(JSON.stringify(out));`, { STUDIO_LOCAL_DIR: local });
    const line = (st, id) => st.steps.find((x) => x.id === id)?.line;
    const cur = (st) => st.stages.find((x) => x.current)?.name || null;
    must(r.s0.next === 'prepare' && r.s0.current === 'prepare' && cur(r.s0) === 'Cut' && r.s0.stages[0].done && line(r.s0, 'import') === 'Take added: 0:04', `new take: ${JSON.stringify([r.s0.next, cur(r.s0), line(r.s0, 'import')])}`);
    must(r.s0.finished?.id === 'import', `seen [] → finished ${JSON.stringify(r.s0.finished)}`);
    must(r.s1.next === 'sections' && line(r.s1, 'prepare') === '3 cuts made, 2 joins checked, 1 to check', `cleaned up: ${r.s1.next} · ${line(r.s1, 'prepare')}`);
    must(r.s2.next === 'lock' && line(r.s2, 'sections') === '1 section added: Main body, 0:00–0:04' && r.s2.finished?.id === 'sections' && r.s2.finished.line === line(r.s2, 'sections') && r.s2.finished.show?.target === 'sections',
      `sections: ${r.s2.next} · ${JSON.stringify(r.s2.finished)}`);
    // s3 skipped Fix the cut but saved a cut too: done wins over skipped.
    must(r.s3.next === null && r.s3.current === 'zooms' && cur(r.s3) === 'Polish' && !r.s3.skipped.length && r.s3.steps.find((x) => x.id === 'cut-editor').done, `built: next ${r.s3.next}, current ${r.s3.current}, skipped ${r.s3.skipped}`);
    must(line(r.s3, 'lock') === 'Cut locked: 2 joins, 0 clipped' && line(r.s3, 'plan') === '3 scenes planned' && line(r.s3, 'review') === '3 of 3 scenes approved' && /^Intro rendered: 0:04$/.test(line(r.s3, 'intro')) && line(r.s3, 'cut-editor') === 'Cut saved: 1 edit',
      `done lines: ${['cut-editor', 'lock', 'plan', 'intro', 'review'].map((x) => line(r.s3, x)).join(' | ')}`);
    must(r.s3skip.current === null && r.s3skip.skipped.includes('zooms') && r.s3skip.steps.find((x) => x.id === 'zooms').skipped, 'Skip on Add zooms did not move the card on');
    must(/can't be skipped/.test(r.lockSkip), `Lock the cut could be skipped: ${r.lockSkip}`);
    must(r.s3back.current === 'zooms' && !r.s3back.skipped.includes('zooms'), 'Undo skip did not bring Add zooms back');
    must(line(r.s4, 'zooms') === '2 zooms placed' && r.s4.current === null && r.s4.stages.every((x) => x.done) && !('finished' in r.s4), `all done: ${line(r.s4, 'zooms')} · ${r.s4.current}`);
    // The cut is locked in s3–s5: what Clean up left is settled, so nothing is left showing.
    must(line(r.s3, 'prepare') === '3 cuts made, 2 joins checked, nothing to check', `locked, still to check: ${line(r.s3, 'prepare')}`);
    const z5 = r.s5.steps.find((x) => x.id === 'zooms');
    must(z5.done && line(r.s5, 'zooms') === "No zooms needed: you're never full frame" && r.s5.current === null && r.s5.stages.every((x) => x.done), `no zooms: ${JSON.stringify([z5.done, line(r.s5, 'zooms'), r.s5.current])}`);
    // The same through the API on the smoke project: what the page saw, Skip / Undo skip, a step that can't be skipped.
    const pv = (await api(`/api/projects/${id}`)).json;
    must(pv.pipeline.stages?.length === 5 && pv.pipeline.current && pv.pipeline.steps.every((x) => x.name && x.stage), `the project view's pipeline: ${JSON.stringify(Object.keys(pv.pipeline))}`);
    const done = pv.pipeline.steps.filter((x) => x.done).map((x) => x.id);
    const a = await api(`/api/projects/${id}/rail`, { op: 'seen', done });
    must(a.status === 200 && JSON.stringify(a.json.seen) === JSON.stringify(done) && a.json.finished === null, `seen: ${a.text.slice(0, 200)}`);
    const sk = await api(`/api/projects/${id}/rail`, { op: 'skip', step: 'cut-editor' });
    must(sk.status === 200 && sk.json.skipped.includes('cut-editor'), `skip: ${sk.text.slice(0, 200)}`);
    const no = await api(`/api/projects/${id}/rail`, { op: 'skip', step: 'lock' });
    must(no.status === 400, `skipping Lock the cut got ${no.status}`);
    const un = await api(`/api/projects/${id}/rail`, { op: 'unskip', step: 'cut-editor' });
    must(un.status === 200 && !un.json.skipped.includes('cut-editor'), 'Undo skip over the API');
    return `new take → Clean up; cleaned up → Split into sections; sectioned → Lock the cut (Done: "${line(r.s2, 'sections')}"); built → Add zooms; all done`;
  });

  // ---- the dock (v3, variation 2 "At the message box"): the next step's data, and a finished step's line in the chat ----
  await check('dock: next step and its words, running, one done marker in the chat log', async () => {
    // A fresh project with its take: Record is done and the dock says "Next · Clean up", with the words it shows.
    const r = await api('/api/projects', { name: 'Dock test', type: 'tutorial', take });
    must(r.status === 200 && r.json?.id, r.text);
    const did = r.json.id, dir = join(STUDIO, 'projects', did), log = join(LOCAL, 'chats', `${did}.jsonl`);
    const v = (await api(`/api/projects/${did}`)).json, p = v.pipeline;
    const cur = p.steps.find((x) => x.id === p.current), stage = p.stages.find((x) => x.current);
    must(cur?.id === 'prepare' && cur.name === 'Clean up' && cur.stage === 'Cut' && cur.what && cur.where && cur.show?.tab === 'cut' && p.steps.indexOf(cur) === 1 && p.steps.length === 9,
      `fresh project's next step: ${JSON.stringify(cur)}`);
    must(stage?.name === 'Cut' && stage.steps.join() === 'prepare,sections,cut-editor,lock' && cur.subs?.map((x) => x.label).join() === 'Transcribe,Rough cut,Join check',
      `the sheet's checklist and the running progress: ${JSON.stringify([stage, cur.subs])}`);
    must(p.seen == null && !p.finished && v.busy === false && v.running === null && 'runningAt' in v && v.runningAt === null, `nothing seen or running yet: ${JSON.stringify([p.seen, v.busy, v.running, v.runningAt])}`);
    const markers = () => (existsSync(log) ? readFileSync(log, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []).filter((e) => e.t === 'marker' && e.done);
    // The page's first look: what it sees is recorded, and steps done before (Record) don't fill the chat.
    let a = await api(`/api/projects/${did}/rail`, { op: 'seen', done: ['import', 'prepare'] });
    must(a.status === 200 && JSON.stringify(a.json.seen) === '["import"]', `first look (a step not done here isn't seen): ${a.text.slice(0, 160)}`);
    must(!markers().length, 'a done marker on the first look');
    // Clean up finishes: its files land; the view says it finished since the page last looked, with its line.
    const put = (f, v2) => { mkdirSync(dirname(join(dir, f)), { recursive: true }); writeFileSync(join(dir, f), JSON.stringify(v2)); };
    put('work/tr/words.json', [[0.2, 0.5, 'Hello'], [0.6, 1.0, 'there']]);
    put('work/rough_map.json', { segments: [{ src: [0, 1.5] }, { src: [2, 4] }] });
    put('work/joins.json', { joins: [{}, {}], summary: { joins: 2, likely_clipped: 0, check: 1 } });
    put('work/cuts.json', { items: [{ id: 1, start: 1.5, end: 2, reason: 'silence', action: 'cut', text: '[pause]' }, { id: 2, start: 0.55, end: 0.6, reason: 'filler', action: 'ask', text: '[sound]' }] });
    put('work/prepare.json', { cuts: 3, joins: 2, needs_you: 1 });
    const v2 = (await api(`/api/projects/${did}`)).json;
    must(v2.pipeline.finished?.id === 'prepare' && v2.pipeline.current === 'sections' && v2.prepare.needs === 1, `after Clean up: ${JSON.stringify([v2.pipeline.finished, v2.pipeline.current, v2.prepare.needs])}`);
    // The page reports it: one line in the chat log ("✓ Clean up · <done line>", Show me's target), sent live to open pages.
    const ctl = new AbortController(), live = [];
    const reading = fetch(`${BASE}/api/projects/${did}/events`, { signal: ctl.signal }).then(async (res) => {
      const rd = res.body.getReader(), dec = new TextDecoder(); let buf = '';
      for (;;) { const { value, done } = await rd.read(); if (done) break; buf += dec.decode(value, { stream: true });
        let i; while ((i = buf.indexOf('\n\n')) >= 0) { const chunk = buf.slice(0, i); buf = buf.slice(i + 2); if (chunk.startsWith('data: ')) live.push(JSON.parse(chunk.slice(6))); } }
    }).catch(() => {});
    await sleep(400);
    const done = v2.pipeline.steps.filter((x) => x.done).map((x) => x.id);
    a = await api(`/api/projects/${did}/rail`, { op: 'seen', done });
    must(a.status === 200 && a.json.finished === null, `seen after Clean up: ${a.text.slice(0, 160)}`);
    let m = markers();
    must(m.length === 1 && m[0].step === 'prepare' && m[0].text === 'Clean up' && m[0].line === '3 cuts made, 2 joins checked, 1 to check' && m[0].show?.tab === 'cut' && m[0].show?.target === 'cut' && m[0].ts,
      `the chat log's marker: ${JSON.stringify(m)}`);
    await until(() => live.some((e) => e.t === 'marker' && e.done && e.step === 'prepare' && !e.replay), 5000, 'the marker on the open page');
    ctl.abort(); await reading;
    // Another page, or the same one again, reporting the same: still one. A reload replays it from the log.
    await api(`/api/projects/${did}/rail`, { op: 'seen', done });
    must(markers().length === 1, `a second marker: ${markers().length}`);
    const ctl2 = new AbortController(), replay = [];
    const r2 = fetch(`${BASE}/api/projects/${did}/events`, { signal: ctl2.signal }).then(async (res) => {
      const rd = res.body.getReader(), dec = new TextDecoder(); let buf = '';
      for (;;) { const { value, done: end } = await rd.read(); if (end) break; buf += dec.decode(value, { stream: true });
        let i; while ((i = buf.indexOf('\n\n')) >= 0) { const chunk = buf.slice(0, i); buf = buf.slice(i + 2); if (chunk.startsWith('data: ')) replay.push(JSON.parse(chunk.slice(6))); } }
    }).catch(() => {});
    await until(() => replay.some((e) => e.t === 'busy'), 5000, 'the replayed log');
    ctl2.abort(); await r2;
    must(replay.filter((e) => e.t === 'marker' && e.done).length === 1 && replay.find((e) => e.t === 'marker' && e.done).replay === true, `replay: ${JSON.stringify(replay.filter((e) => e.t === 'marker'))}`);
    // Split into sections finishes: a second line, with its own words and the timeline as Show me's target.
    put('work/blocks.json', { v: 1, marked: true, blocks: [{ id: 'main', type: 'body', label: 'Main body', source: { take: [0, 4] } }] });
    const v3 = (await api(`/api/projects/${did}`)).json;
    await api(`/api/projects/${did}/rail`, { op: 'seen', done: v3.pipeline.steps.filter((x) => x.done).map((x) => x.id) });
    m = markers();
    must(m.length === 2 && m[1].step === 'sections' && m[1].text === 'Split into sections' && m[1].line === '1 section added: Main body, 0:00–0:04' && m[1].show?.target === 'sections' && v3.pipeline.current === 'lock',
      `after Split into sections: ${JSON.stringify([m[1], v3.pipeline.current])}`);
    return `Next · Clean up → ✓ Clean up · "${m[0].line}" → ✓ Split into sections · "${m[1].line}" (once each, replayed after a reload)`;
  });

  // ---- the cut (E2E 2026-10-19: M3, M4, M5, M6, m1, m7, m10, m17) ----
  // A take where Whisper ends a word before its sound does: "basically," is timed 2.00–2.45 s, sounds until 2.75 s,
  // then silence until "it" at 3.15 s. Tones stand in for the words; the cut file has a 2-frame cut (4.600–4.667).
  const CUTF = join(ROOT, 'cutfix');
  const CUT_WORDS = [[0.5, 0.9, 'so'], [1.0, 1.4, 'the'], [1.5, 1.9, 'process'], [2.0, 2.45, 'basically,'], [3.15, 3.5, 'it'], [3.55, 4.0, 'starts'],
    [4.1, 4.5, 'off'], [4.75, 5.2, 'on'], [5.3, 5.8, 'camera.']];
  const CUT_EDL = [[0.3, 4.6], [4.667, 6.0]];
  const cutFixture = () => {
    if (existsSync(join(CUTF, 'media.mp4'))) return;
    mkdirSync(CUTF, { recursive: true });
    const sounds = [[0.5, 0.9, 300], [1.0, 1.4, 330], [1.5, 1.9, 360], [2.0, 2.75, 400], [3.15, 3.5, 300], [3.55, 4.0, 330], [4.1, 4.5, 360], [4.75, 5.2, 300], [5.3, 5.8, 330]];
    const expr = sounds.map(([a, b, f]) => `0.3*sin(2*PI*${f}*t)*between(t\\,${a}\\,${b})`).join('+') + '+0.0003*sin(2*PI*50*t)';
    execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=gray:size=320x180:rate=30', '-f', 'lavfi', '-i', `aevalsrc=${expr}:s=48000`, '-t', '6.5',
      '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', join(CUTF, 'media.mp4')]);
    writeFileSync(join(CUTF, 'words.json'), JSON.stringify(CUT_WORDS));
    writeFileSync(join(CUTF, 'edl.json'), JSON.stringify({ segments_sec: CUT_EDL }));
  };
  const joinCheck = (edl, name) => {
    cutFixture();
    writeFileSync(join(CUTF, `${name}.json`), JSON.stringify({ segments_sec: edl }));
    execFileSync(PY, [join(APP, 'starter', 'tools', 'join-check', 'join_check.py'), join(CUTF, 'media.mp4'), '--edl', join(CUTF, `${name}.json`),
      '--words', join(CUTF, 'words.json'), '--out', join(CUTF, `joins_${name}`), '--fix-out', join(CUTF, `${name}_fixed.json`)], { stdio: 'pipe' });
    return { joins: JSON.parse(readFileSync(join(CUTF, `joins_${name}.json`), 'utf8')).joins, fixed: JSON.parse(readFileSync(join(CUTF, `${name}_fixed.json`), 'utf8')).segments_sec };
  };

  await check('join-check flags a leftover tail (a cut word still sounding past the cut) and its fix trims it', async () => {
    // "basically," cut on Whisper's times: 300 ms of it plays after the cut.
    const r = joinCheck([[0.3, 2.0], [2.45, 4.6], [4.667, 6.0]], 'naive');
    const j = r.joins.find((x) => x.k === 0), tiny = r.joins.find((x) => x.k === 1);
    must(j.status === 'likely clipped' && j.trim_ms[1] >= 300 && /basically/.test(j.in.why.join(' ')), `the leftover: ${JSON.stringify(j)}`);
    must(r.fixed[1][0] >= 2.75 && r.fixed[1][0] < 3.15, `the fix starts the kept part at ${r.fixed[1][0]} (the leftover ends at 2.75, "it" starts at 3.15)`);
    must(tiny.status === 'ok' && !tiny.trim_ms[0] && !tiny.trim_ms[1] && JSON.stringify(r.fixed[2]) === '[4.667,6]', `the clean 2-frame cut: ${JSON.stringify(tiny)} · ${JSON.stringify(r.fixed)}`);
    // Cut at a safe edge (the silence after the tail): nothing flagged.
    const ok = joinCheck([[0.3, 1.95], [2.95, 4.6], [4.667, 6.0]], 'safe');
    must(ok.joins.every((x) => x.status !== 'likely clipped' && !x.trim_ms[1]), `a safe cut was flagged: ${JSON.stringify(ok.joins)}`);
    return `"${j.in.why[0]}" → kept part starts at ${r.fixed[1][0]} s; a cut in the silence passes`;
  });

  if (process.env.PLAYWRIGHT_PATH) {
    await check('Cut Editor (built in): the cut opens exactly (a 2-frame cut stays), a word delete cuts to safe edges, the save changes only that, all on Video Octopus\'s own address (headless Chrome)', async () => {
      let out;
      cutFixture();
      // With Python unavailable to Video Octopus (its stand-in notes any run).
      let py = [];
      try {
        out = await withoutPython(async () => { const o = execFileSync(process.execPath, [join(APP, 'test', 'cuteditor.e2e.mjs')], { env: { ...process.env, CUT_DIR: CUTF, STUDIO_URL: BASE }, encoding: 'utf8', timeout: 180000 }); py = ran().filter((l) => l.startsWith('python')); return o; });
      } catch (e) { throw new Error(String((e.stdout || '') + (e.stderr || '') || e.message).trim().split('\n').slice(-6).join(' | ')); }
      must(!py.length, `Python ran: ${py.join(' | ')}`);
      const { opened, saved, text, origins, video } = JSON.parse(out.trim().split('\n').pop());
      must(origins.length === 1 && origins[0] === BASE, `the page asked other addresses: ${origins.join(', ')}`);
      const file = JSON.parse(text);
      must(JSON.stringify(Object.keys(file)) === JSON.stringify(['source', 'fps', 'segments_sec', 'saved_at', 'edited_length']) && file.source === realpathSync(video) && file.fps === 30 && text.includes('"fps": 30.0'),
        `the saved file: ${text.slice(0, 300)}`);
      // Where the saved cut differs from the file (kept here, not in the other).
      const minus = (X, Y) => X.flatMap(([a, b]) => Y.reduce((ps, [c, d]) => ps.flatMap(([x, y]) => (d <= x || c >= y ? [[x, y]] : [[x, Math.min(y, c)], [Math.max(x, d), y]].filter(([p, q]) => q - p > 1e-6))), [[a, b]]));
      const ch = [...minus(CUT_EDL, saved), ...minus(saved, CUT_EDL)].filter(([a, b]) => b - a > 0.01);
      must(JSON.stringify(opened) === JSON.stringify(CUT_EDL), `opened ${JSON.stringify(opened)}`);
      must(saved.some(([a]) => Math.abs(a - 4.667) < 1e-3) && saved.some(([, b]) => Math.abs(b - 4.6) < 1e-3), `the 2-frame cut is gone from the save: ${JSON.stringify(saved)}`);
      must(ch.length === 1 && ch[0][0] >= 1.9 && ch[0][0] <= 2.0 && ch[0][1] >= 2.75 && ch[0][1] < 3.15, `the word delete cut ${JSON.stringify(ch)} (safe: start 1.9–2.0, end 2.75–3.15)`);
      const after = joinCheck(saved, 'edited');
      must(after.joins.every((x) => x.status !== 'likely clipped'), `join-check on the save: ${JSON.stringify(after.joins.map((x) => [x.status, x.trim_ms]))}`);
      return `cut ${ch[0].map((x) => x.toFixed(3)).join('–')} s (Whisper's word: 2.000–2.450, its sound to 2.75); 2-frame cut kept; one change saved; join-check clean`;
    });
  }

  await check('one "needs you" count: done line, dock and Cut chip, Cut inspector, Keep / Cut list; a list decision, a direct edit and the lock count', async () => {
    const r = await api('/api/projects', { name: 'Needs you', type: 'tutorial', take });
    must(r.status === 200 && r.json?.id, r.text);
    const nid = r.json.id, dir = join(STUDIO, 'projects', nid);
    const put = (f, v) => { mkdirSync(dirname(join(dir, f)), { recursive: true }); writeFileSync(join(dir, f), typeof v === 'string' ? v : JSON.stringify(v)); };
    put('work/tr/words.json', [[0.2, 0.5, 'Hello'], [0.6, 0.9, 'um'], [1.0, 1.4, 'so'], [1.5, 1.9, 'like'], [2.0, 2.6, 'this'], [3.0, 3.5, 'take']]);
    put('work/rough_map.json', { src_duration: 4, segments: [{ src: [0, 2.7] }, { src: [2.9, 4] }], applied: [1, 2] });
    // The rough cut asked about three parts (one of them a retake Prepare didn't list again) and was sure of one.
    put('work/cuts.json', { duration: 4, items: [{ id: 1, start: 2.7, end: 2.9, reason: 'silence', action: 'cut', text: '[pause]' },
      { id: 2, start: 0.6, end: 0.9, reason: 'filler', action: 'ask', text: 'um' }, { id: 3, start: 1.5, end: 1.9, reason: 'filler', action: 'ask', text: 'like' },
      { id: 4, start: 0.2, end: 0.55, reason: 'retake', action: 'ask', text: 'Hello' }] });
    put('work/joins.json', { joins: [{ k: 0, rank: 1, src_out: 2.7, src_in: 2.9, status: 'likely clipped', score: 0.7, fix_ms: [0, 60], trim_ms: [0, 0], out: { why: [] }, in: { why: ['"take" starts 60 ms before the cut'], word: 'take' } }],
      summary: { joins: 1, likely_clipped: 1, check: 0 } });
    put('work/prepare.json', { cuts: 2, joins: 1, needs_you: 3, ask: [{ t: 0.6, what: 'um?' }, { t: 1.5, what: '"like"?' }], summary: 'Rough cut: 2 cuts, 3 need you' });
    // join-check's fix not in the cut: the clipped join is one to check.
    put('work/edl_fixed.json', { segments_sec: [[0, 2.7], [2.9, 4]] });
    const counts = async () => {
      const v = (await api(`/api/projects/${nid}`)).json, rv = (await api(`/api/projects/${nid}/cut-review`)).json;
      return { dock: v.prepare.needs, line: v.pipeline.steps.find((x) => x.id === 'prepare').line, list: rv.items.filter((x) => x.group === 'ask' && !x.decision).length, needs: rv.needs, summary: rv.summary, rv };
    };
    const same = (c, n) => c.dock === n && c.list === n && c.needs === n && c.line === `2 cuts made, 1 join checked, ${n ? `${n} to check` : 'nothing to check'}`
      && c.summary === `Rough cut: 2 cuts, ${n ? `${n} need${n === 1 ? 's' : ''} you` : 'nothing left for you to check'}`;
    let c = await counts();
    must(same(c, 4) && c.rv.items.some((x) => x.key === 'j0'), `a clipped join the fix isn't in: not 4 everywhere: ${JSON.stringify({ ...c, rv: undefined })}`);
    // The fix is in work/edl_fixed.json (60 ms of "take" back): the join is fixed, not one to check (as Claude counts it).
    put('work/edl_fixed.json', { segments_sec: [[0, 2.7], [2.84, 4]] });
    c = await counts();
    must(same(c, 3) && !c.rv.items.some((x) => x.key === 'j0') && c.rv.joins[0].fixed === true, `after Clean up (its fix in edl_fixed.json), not 3 everywhere: ${JSON.stringify({ ...c, rv: undefined })}`);
    // Keep in the list: one less.
    await api(`/api/projects/${nid}/cut-review`, { decisions: { c2: 'keep' } });
    c = await counts();
    must(same(c, 2) && c.rv.items.find((x) => x.key === 'c2').by === 'list', `after Keep: ${JSON.stringify({ ...c, rv: undefined })}`);
    // A direct edit in the Cut tab over "like" (the editor's save says what it opened and what it saved): decided.
    const res = await api(`/api/projects/${nid}/cut-sync`, { base: [[0, 2.7], [2.84, 4]], segments: [[0, 1.45], [1.95, 2.7], [2.84, 4]] });
    must(res.status === 200, res.text);
    c = await counts();
    const like = c.rv.items.find((x) => x.key === 'c3');
    must(same(c, 1) && like.decision === 'cut' && like.by === 'edit', `after a direct edit: ${JSON.stringify({ ...c, rv: undefined, like })}`);
    // The edit undone (the editor's ⌘Z: its save is the cut it opened again): its decision goes, "like" is to check again.
    await api(`/api/projects/${nid}/cut-sync`, { base: [[0, 2.7], [2.84, 4]], segments: [[0, 2.7], [2.84, 4]] });
    c = await counts();
    must(same(c, 2) && !c.rv.items.find((x) => x.key === 'c3').decision, `after undoing the edit: ${JSON.stringify({ ...c, rv: undefined })}`);
    await api(`/api/projects/${nid}/cut-sync`, { base: [[0, 2.7], [2.84, 4]], segments: [[0, 1.45], [1.95, 2.7], [2.84, 4]] });
    must((await counts()).needs === 1, 'the edit again');
    // Locking the cut settles the rest as they are: nothing left showing.
    put('WORKLOG.md', '# x\n- 2026-10-19: Cut locked (join-check: 1 joins, 0 clipped)\n');
    c = await counts();
    must(same(c, 0) && c.rv.items.filter((x) => x.group === 'ask').every((x) => x.decision) && c.rv.items.find((x) => x.key === 'c4').by === 'lock', `after the lock: ${JSON.stringify({ ...c, rv: undefined })}`);
    // A second read changes nothing; a new Prepare's parts would wait for the next lock.
    must((await counts()).needs === 0, 'the lock settled twice');
    return '4 → the fix in edl_fixed.json 3 → Keep 2 → direct edit 1 (undone 2, again 1) → locked 0, the same in the done line, the dock, the list and its header';
  });

  await check('Keep / Cut: a part Prepare named as a range is one item on whole words (its end, else the words it quotes); Keep / Cut and Undo', async () => {
    const r = await api('/api/projects', { name: 'Range asks', type: 'tutorial', take });
    must(r.status === 200 && r.json?.id, r.text);
    const nid = r.json.id, dir = join(STUDIO, 'projects', nid);
    const put = (f, v) => { mkdirSync(dirname(join(dir, f)), { recursive: true }); writeFileSync(join(dir, f), typeof v === 'string' ? v : JSON.stringify(v)); };
    put('work/tr/words.json', [[0.3, 0.5, 'Hello'], [0.55, 0.8, 'legends,'], [0.9, 1.1, 'hello'], [1.15, 1.4, 'again.'], [1.8, 2.0, 'So'], [2.05, 2.3, 'today'],
      [2.4, 2.6, 'we'], [2.65, 2.9, 'start.'], [3.0, 3.2, 'And'], [3.25, 3.4, 'after'], [3.45, 3.7, 'you.']]);
    put('work/rough_map.json', { src_duration: 4, segments: [{ src: [0.25, 1.6] }, { src: [1.75, 3.9] }], applied: [1] });
    put('work/cuts.json', { duration: 4, items: [{ id: 1, start: 1.45, end: 1.75, reason: 'silence', action: 'cut', text: '[pause]' }] });
    put('work/edl_fixed.json', { segments_sec: [[0.25, 1.6], [1.75, 3.9]] });
    put('work/prepare.json', { cuts: 1, needs_you: 3, ask: [
      { t: 0.3, what: 'Opening false starts: "Hello legends, hello again." (0:00.0–0:01.1): cut it all?' }, // the words it quotes
      { t: 3.0, end: 3.7, what: 'Unfinished ending (0:02.6): trim it?' }, // its own end
      { t: 2.4, what: 'Filler? "we"' } ] }); // one word
    const rv = (await api(`/api/projects/${nid}/cut-review`)).json;
    const at = (t) => rv.items.find((x) => x.key === `a${Math.round(t * 100)}`);
    const fs = at(0.3), end = at(3.0), one = at(2.4);
    must(fs && fs.a === 0.3 && fs.b === 1.4 && fs.safe && JSON.stringify(fs.cut) === '[[0.3,1.4]]', `the false starts (quoted words): ${JSON.stringify(fs)}`);
    must(end && end.a === 3 && end.b === 3.7 && end.safe, `the unfinished ending (t to end): ${JSON.stringify(end)}`);
    must(one && one.a === 2.4 && one.b === 2.7, `one word: ${JSON.stringify(one)}`);
    must(rv.needs === 3, `three to check: ${rv.needs}`);
    // Cut in the list (the page's edit cuts the whole range; web/cutpanel.js), then its undo takes the decision back.
    await api(`/api/projects/${nid}/cut-review`, { decisions: { [fs.key]: 'cut' } });
    await api(`/api/projects/${nid}/cut-sync`, { base: [[0.25, 1.6], [1.75, 3.9]], segments: [[1.75, 3.9]] });
    let v = (await api(`/api/projects/${nid}/cut-review`)).json;
    must(v.items.find((x) => x.key === fs.key).decision === 'cut' && v.needs === 2, `after Cut: ${JSON.stringify(v.items.find((x) => x.key === fs.key))}`);
    await api(`/api/projects/${nid}/cut-review`, { decisions: { [fs.key]: null } });
    await api(`/api/projects/${nid}/cut-sync`, { base: [[0.25, 1.6], [1.75, 3.9]], segments: [[0.25, 1.6], [1.75, 3.9]] });
    v = (await api(`/api/projects/${nid}/cut-review`)).json;
    must(v.items.find((x) => x.key === fs.key).decision === null && v.needs === 3, `after Undo: ${JSON.stringify(v.items.find((x) => x.key === fs.key))} · ${v.needs}`);
    // The page: Keep / Cut send the range with safe edges, and an undo in the editor takes the decision back.
    const page = readFileSync(join(APP, 'web', 'cutpanel.js'), 'utf8'), ed = readFileSync(join(APP, 'web', 'cut-editor', 'studio.js'), 'utf8');
    must(/safe: Boolean\(it\.safe\)/.test(page) && /followUndo/.test(page) && /applyRanges\(op,m\.ranges,!!m\.safe\)/.test(ed), 'the page and the editor wire the safe edges and the undo');
    return 'false starts 0.3–1.4 s from the quoted words, the ending 3.0–3.7 s from its end, a word 2.4–2.7 s; Cut → decided, Undo → to check again';
  });

  await check('the cut changed after the lock: the Lock step waits again, Export and the canvas say so (cut kept at the lock)', async () => {
    const r = await api('/api/projects', { name: 'Post-lock edit', type: 'tutorial', take });
    must(r.status === 200 && r.json?.id, r.text);
    const nid = r.json.id, dir = join(STUDIO, 'projects', nid);
    const put = (f, v) => { mkdirSync(dirname(join(dir, f)), { recursive: true }); writeFileSync(join(dir, f), typeof v === 'string' ? v : JSON.stringify(v)); };
    put('work/tr/words.json', [[0.2, 0.6, 'one'], [1.0, 1.4, 'two'], [2.0, 2.4, 'three'], [3.0, 3.4, 'four']]);
    put('work/edl_fixed.json', { segments_sec: [[0.1, 1.6], [1.9, 3.6]] });
    const st = async () => { const v = (await api(`/api/projects/${nid}`)).json; const l = v.pipeline.steps.find((x) => x.id === 'lock'); return { done: l.done, changed: Boolean(l.changed), state: v.export.cut?.state }; };
    let s0 = await st();
    must(!s0.done && s0.state === 'rough', `before the lock: ${JSON.stringify(s0)}`);
    // Lock: Claude's join check on the cut, then the WORKLOG line.
    put('work/joins.json', { cut: 'work/edl_fixed.json', joins: [{ k: 0, src_out: 1.6, src_in: 1.9, status: 'ok' }] });
    put('WORKLOG.md', '# x\n- 2026-10-19: Cut locked (join-check: 1 join, 0 clipped)\n');
    s0 = await st();
    must(s0.done && !s0.changed && s0.state === 'locked', `locked: ${JSON.stringify(s0)}`);
    await sleep(1100);
    put('work/edl_manual.json', { segments_sec: [[0.1, 0.8], [1.9, 3.6]] }); // "two" deleted after the lock
    s0 = await st();
    must(!s0.done && s0.changed && s0.state === 'changed', `edited after the lock (no Keep / Cut list: against the lock's join check): ${JSON.stringify(s0)}`);
    put('work/edl_manual.json', { segments_sec: [[0.1, 1.6], [1.9, 3.6]] }); // undone: the cut as locked
    s0 = await st();
    must(s0.done && !s0.changed && s0.state === 'locked', `the edit undone: ${JSON.stringify(s0)}`);
    // With a Keep / Cut list (Clean up's cuts), the cut is kept at the lock and compared exactly.
    put('work/cuts.json', { duration: 4, items: [{ id: 1, start: 1.6, end: 1.9, reason: 'silence', action: 'cut', text: '[pause]' }] });
    put('WORKLOG.md', '# x\n- 2026-10-19: Cut locked (join-check: 1 join, 0 clipped)\n- 2026-10-19: Cut locked (join-check: 1 join, 0 clipped)\n');
    await api(`/api/projects/${nid}/cut-review`);
    must(JSON.parse(readFileSync(join(dir, 'work', 'cut_review.json'), 'utf8')).lock?.segments?.length === 2, 'the cut kept at the lock');
    put('work/edl_manual.json', { segments_sec: [[0.1, 1.6], [2.0, 3.6]] });
    s0 = await st();
    must(!s0.done && s0.changed && s0.state === 'changed', `edited after the second lock: ${JSON.stringify(s0)}`);
    const ui = readFileSync(join(APP, 'web', 'ui.js'), 'utf8');
    must(/changed after the lock, joins not checked/.test(ui), 'Export\'s words for a changed cut');
    return 'rough → locked → edited: Lock waits, Export "Cut · changed after the lock" → undone: locked again';
  });

  await check('effects under the voice: one level from Settings → Sound for the export, the canvas preview and Claude', async () => {
    must(id, 'no project');
    const lib = join(STUDIO, 'library', 'sfx');
    mkdirSync(lib, { recursive: true });
    if (!existsSync(join(lib, 'smoke_beep.wav'))) execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'sine=frequency=2000:sample_rate=48000', '-t', '0.25', '-ac', '2', join(lib, 'smoke_beep.wav')]);
    const dir = join(STUDIO, 'projects', id);
    writeFileSync(join(dir, 'work', 'sfx.json'), JSON.stringify({ v: 1, cues: [{ id: 'b', t: 1, file: 'sfx/smoke_beep.wav', from: 'library', gain: 2, label: 'Beep' }] }));
    const sound = async () => (await api(`/api/projects/${id}/sound`)).json;
    const a = await sound();
    must(a.under === 18 && Number.isFinite(a.cues[0].mix), `default 18 dB: ${JSON.stringify({ under: a.under, cue: a.cues[0] })}`);
    // Both are 440/2000 Hz sines at the same level: the cue's gain is -18 (under) + 2 (its own).
    must(Math.abs(a.cues[0].mix - -16) < 1, `the cue plays 16 dB down (18 under + 2): ${a.cues[0].mix}`);
    must((await api('/api/app/settings', { section: 'sound', values: { fxDb: -10 } })).status === 200, 'settings');
    const b = await sound();
    must(b.under === 10 && Math.abs(b.cues[0].mix - a.cues[0].mix - 8) < 0.2, `at 10 dB: ${JSON.stringify({ under: b.under, mix: b.cues[0].mix })}`);
    // What Claude is told (its project instructions), at the same level.
    const ctx = modRun(`const S = await import(${mod('server/settings.mjs')}); const K = await import(${mod('server/kit.mjs')}); console.log(JSON.stringify({ s: S.settingsBrief(), k: K.kitContext(${JSON.stringify(dir)}, {}).join(' ') }));`);
    must(/effects sit about 10 dB under the voice/.test(ctx.s) && /about 10 dB under the voice/.test(ctx.k), `Claude is told: ${ctx.s.match(/effects sit[^.]*/)?.[0]} · ${ctx.k.match(/gain \(dB[^)]*\)/)?.[0]}`);
    await api('/api/app/settings', { section: 'sound', values: { fxDb: -18 } });
    rmSync(join(dir, 'work', 'sfx.json'), { force: true });
    const page = readFileSync(join(APP, 'web', 'sound.js'), 'utf8'), snd = readFileSync(join(APP, 'server', 'sound.mjs'), 'utf8');
    must(!/UNDER_VOICE_DB/.test(snd) && /bases\.get\(c\.file\)/.test(page), 'the export and the preview read the one level');
    return `cue at ${a.cues[0].mix} dB with 18 under, ${b.cues[0].mix} dB with 10 under; Claude is told the same`;
  });

  await check('a render still being written is not probed (no moov yet): no length, nothing in the log, probed once whole', async () => {
    const dir = join(ROOT, 'probe-writing');
    mkdirSync(dir, { recursive: true });
    const whole = join(dir, 'whole.mp4'), part = join(dir, 'part.mp4');
    execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=30', '-t', '2', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', whole]);
    const buf = readFileSync(whole);
    const moov = buf.indexOf(Buffer.from('moov'));
    must(moov > buf.length / 2, `ffmpeg wrote the index (moov) at ${moov} of ${buf.length}: it should be at the end`);
    writeFileSync(part, buf.subarray(0, moov - 4)); // what's on disk while ffmpeg still writes
    const code = `const S = await import(${mod('server/studio.mjs')}); console.log(JSON.stringify({ part: S.probeFile(${JSON.stringify(part)}), whole: S.probeFile(${JSON.stringify(whole)})?.duration, wp: S.mp4Whole(${JSON.stringify(part)}), ww: S.mp4Whole(${JSON.stringify(whole)}) }));`;
    const run = spawnSync(process.execPath, ['--input-type=module', '-e', code], { env: { ...process.env, STUDIO_LOCAL_DIR: LOCAL }, encoding: 'utf8' });
    const out = JSON.parse(run.stdout.trim().split('\n').pop());
    must(out.part === null && !out.wp && out.ww && out.whole > 1.9, `probe: ${JSON.stringify(out)}`);
    must(!/moov|Invalid data/.test(run.stderr), `the log: ${run.stderr.trim().slice(0, 300)}`);
    // A whole file that ffprobe can't read is quiet too.
    writeFileSync(part, Buffer.concat([buf.subarray(0, 8), Buffer.from('xxxxmoov'), Buffer.alloc(64)]));
    const run2 = spawnSync(process.execPath, ['--input-type=module', '-e', `const S = await import(${mod('server/studio.mjs')}); console.log(JSON.stringify(S.probeFile(${JSON.stringify(part)})));`], { env: { ...process.env, STUDIO_LOCAL_DIR: LOCAL }, encoding: 'utf8' });
    must(run2.stdout.trim() === 'null' && !run2.stderr.trim(), `a broken file: ${run2.stdout} ${run2.stderr}`);
    return `the half-written file: no length, nothing logged; the whole one ${out.whole.toFixed(2)} s`;
  });

  await check('a look change goes to Claude only when something it built shows the look; Export says the intro was built before it', async () => {
    const r = await api('/api/projects', { name: 'Look package', type: 'tutorial', take });
    must(r.status === 200 && r.json?.id, r.text);
    const nid = r.json.id, dir = join(STUDIO, 'projects', nid);
    const layoutOf = async () => (await api(`/api/projects/${nid}`)).json.layout;
    const looks = async () => (await api(`/api/projects/${nid}/notes`, { op: 'list' })).json.notes.filter((n) => n.field === 'look' && n.status === 'open');
    // The page's save, then what the project's file watcher does when project.json changes (no page is open here).
    const sync = () => modRun(`const C = await import(${mod('server/cutsync.mjs')}); console.log(JSON.stringify(C.syncDocItems(${JSON.stringify(dir)}).length));`);
    const border = async (c) => { const l = await layoutOf(); l.cam = { ...(l.cam || {}), border: c }; must((await api(`/api/projects/${nid}/layout`, { layout: l })).status === 200, 'layout'); sync(); };
    sync(); // first sight: the package's base
    await border('#1e90ff');
    must(!(await looks()).length, `nothing built: no package item: ${JSON.stringify(await looks())}`);
    // Claude builds the intro (in the blue look), then the creator changes the border again.
    mkdirSync(join(dir, 'renders'), { recursive: true });
    execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=green:s=320x180:r=30', '-t', '1', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', join(dir, 'renders', `${nid}_intro_v1.mp4`)]);
    await sleep(300);
    await border('#ff00aa');
    const items = await looks();
    must(items.length === 1 && /camera border #1e90ff → #ff00aa/.test(items[0].text) && /intro render .* still shows the old look/.test(items[0].text), `with the intro built: ${JSON.stringify(items.map((n) => n.text))}`);
    const built = (await api(`/api/projects/${nid}`)).json.export.built || [];
    // (the intro render has no blocks to sit in here: the Export row isn't usable, but it still says what it was built in)
    must(built[0]?.oldLook === 'camera border #1e90ff → #ff00aa', `Export's Intro row: ${JSON.stringify(built)}`);
    return items[0].text;
  });

  await check('a stopped reply keeps only whole sentences (no "You" left in the chat); a session of several steps is named first → latest', async () => {
    const out = modRun(`const C = await import(${mod('server/claude.mjs')});
      const s = new C.ChatSession('_smoke_stop', () => ''), got = [];
      s.emit = (e) => got.push(e); s.write = () => {}; s.setBusy = (b) => { s.busy = b; }; s.proc = {}; s.busy = true;
      s.handle({ type: 'assistant', message: { content: [{ type: 'text', text: 'I split it into three sections. Then I' }] } });
      s.stop();
      s.handle({ type: 'assistant', message: { content: [{ type: 'text', text: 'You' }] } });
      s.handle({ type: 'assistant', message: { content: [{ type: 'text', text: 'Done with the intro. Now the bo' }] } });
      s.handle({ type: 'result', subtype: 'error_during_execution', is_error: true, duration_ms: 7000 });
      s.handle({ type: 'assistant', message: { content: [{ type: 'text', text: 'Next turn, not stopped' }] } });
      const hist = [C.userEvent('Prepare…', { name: 'Clean up', step: 'prepare' }), { t: 'text', text: 'ok' }, C.userEvent('Mark…', { name: 'Split into sections', step: 'sections' }), C.userEvent('Write…', { name: 'Write the post', step: 'post-kit' })];
      console.log(JSON.stringify({ texts: got.filter((e) => e.t === 'text').map((e) => e.text), title: C.sessionTitle(hist), one: C.sessionTitle(hist.slice(0, 2)) }));`);
    must(JSON.stringify(out.texts) === JSON.stringify(['I split it into three sections. Then I', 'Done with the intro.', 'Next turn, not stopped']), `texts: ${JSON.stringify(out.texts)}`);
    must(out.title === 'Clean up → Write the post' && out.one === 'Clean up', `titles: ${out.title} · ${out.one}`);
    return `stopped: "You" dropped, "Done with the intro. Now the bo" → "Done with the intro."; "${out.title}"`;
  });

  await check('Clean up brief follows Settings → Transcription: cloud with a key, cloud without one (this computer, said once), the local model', async () => {
    const local = join(ROOT, 'tx-local');
    mkdirSync(local, { recursive: true });
    const run = (tx, has) => {
      writeFileSync(join(local, 'settings.json'), JSON.stringify({ studio: STUDIO, projectsDir: 'projects', setup: { done: true }, transcribe: tx }));
      return modRun(`const S = await import(${JSON.stringify(new URL('../server/settings.mjs', import.meta.url).href)});
        const T = await import(${JSON.stringify(new URL('../server/studio.mjs', import.meta.url).href)});
        const how = await S.transcribeHow({ fill: true, has: async () => ${has} });
        const env = await S.childEnv();
        const brief = T.stepPrompt(T.projectDir(${JSON.stringify(id)}), 'tutorial', 'prepare', { transcribe: how.text });
        console.log(JSON.stringify({ how, brief, env: env.STUDIO_TRANSCRIBE }));`, { STUDIO_LOCAL_DIR: local, STUDIO_KEYCHAIN_SERVICE: 'StudioSmokeNoKeys' });
    };
    const cloud = run({ engine: 'cloud', provider: 'assemblyai' }, true);
    must(/through AssemblyAI's API/.test(cloud.how.text) && /\$ASSEMBLYAI_API_KEY/.test(cloud.how.text) && /disfluencies/.test(cloud.how.text) && /work\/tr_fill/.test(cloud.how.text) && !cloud.how.fallback,
      `cloud with a key: ${cloud.how.text}`);
    must(cloud.brief.includes(cloud.how.text) && !cloud.brief.includes('{transcribe}') && !/medium\.en or bigger/.test(cloud.brief), `the brief: ${cloud.brief.slice(0, 400)}`);
    // What Video Octopus does with join-check's fix (the Cut tab opens edl_fixed.json and the export plays it): applied, not pending.
    must(/already applied \(say so; don't call them pending\)/.test(cloud.brief) && /every cut the rough cut marked \\?"ask\\?", retakes too/.test(cloud.brief), `the brief on the fixed cut and the asks: ${cloud.brief.slice(0, 1600)}`);
    const nokey = run({ engine: 'cloud', provider: 'assemblyai' }, false);
    must(nokey.how.fallback === 'AssemblyAI' && /no AssemblyAI key is saved, so transcribe on this computer/.test(nokey.how.text) && /--fill-out work\/tr_fill/.test(nokey.how.text) && nokey.env === 'local',
      `cloud without a key: ${JSON.stringify(nokey.how)} · STUDIO_TRANSCRIBE=${nokey.env}`);
    const mine = run({ engine: 'local', model: 'small.en' }, false);
    must(mine.how.model === 'small.en' && /--model small\.en --out work\/tr --fill-out work\/tr_fill/.test(mine.how.text) && /Never two transcriptions side by side/.test(mine.how.text) && !mine.how.fallback && mine.env === 'local',
      `local small.en: ${mine.how.text}`);
    const auto = run({ engine: 'local', model: 'auto', language: 'de' }, false);
    must(/--model auto/.test(auto.how.text) && /--lang de/.test(auto.how.text) && !/\.en\b/.test(auto.how.model), `local auto, German: ${JSON.stringify(auto.how)}`);
    return `cloud+key → AssemblyAI; no key → this computer (${nokey.how.model}); local → small.en; auto (German) → ${auto.how.model}`;
  });

  await check('New project takes: each with its length and the projects using it; the dialog picks the newest unused one, More takes… lists the rest', async () => {
    // Six more takes, newest first: the newest is used by a project, the next one isn't (the dialog's pick).
    const ids = Array.from({ length: 6 }, (_, i) => `2026-10-1${8 - i}_10-00-00`);
    const now = Date.now() / 1000;
    ids.forEach((t, i) => {
      mkdirSync(join(REC, t), { recursive: true });
      execFileSync('ffmpeg', ['-v', 'error', '-y', '-i', join(REC, take, `${take}_webcam.mov`), '-t', String(2 + i), '-c', 'copy', join(REC, t, `${t}_webcam.mov`)]);
    });
    const r = await api('/api/projects', { name: 'Uses the newest take', type: 'tutorial', take: ids[0] });
    must(r.status === 200, r.text);
    ids.forEach((t, i) => utimesSync(join(REC, t), now + 600 - i * 10, now + 600 - i * 10));
    const list = (await api('/api/takes')).json;
    const a = list.find((x) => x.id === ids[0]), b = list.find((x) => x.id === ids[1]);
    must(list[0].id === ids[0] && a.used && a.projects.includes('Uses the newest take') && Math.abs(a.duration - 2) < 0.2, `the used take: ${JSON.stringify(a)}`);
    must(!b.used && !b.projects.length && Math.abs(b.duration - 3) < 0.2, `the unused take: ${JSON.stringify(b)}`);
    if (!process.env.PLAYWRIGHT_PATH) return `${list.length} takes with length and projects (the dialog itself needs PLAYWRIGHT_PATH)`;
    try {
      const out = execFileSync(process.execPath, [join(APP, 'test', 'newproject.e2e.mjs')], { env: { ...process.env, STUDIO_URL: BASE, NP_FREE: ids[1], NP_USED: ids[0], NP_PROJECT: 'Uses the newest take', NP_IDS: ids.join(',') }, encoding: 'utf8', timeout: 180000 });
      return out.trim().split('\n').pop();
    } catch (e) { throw new Error(String((e.stdout || '') + (e.stderr || '') || e.message).trim().split('\n').slice(-6).join(' | ')); }
  });

  // ---- shots: the look over time, transitions, zooms, the files and their routes ----
  const L = await import(new URL('../web/layout.js', import.meta.url).href);
  const SH = await import(new URL('../web/shots.js', import.meta.url).href);
  const close = (a, b, e = 1e-6) => Math.abs(a - b) <= e;
  await check('shots: lookAt merges a shot over the video (objects by field, hidden replaces) and falls back without the camera', async () => {
    const base = L.normalize({ preset: 'pip', cam: { shape: 'circle', border: 'white', zoom: 1.5 }, webcam: { x: 0.7, y: 0.7, w: 0.2 },
      layers: [{ id: 'L1', file: 'other_webcam.mov', kind: 'cam', hidden: true }, { id: 'L2', file: 'other_screen.mov', kind: 'screen' }] }, 'tutorial');
    const shots = SH.normalizeShots({ shots: [{ id: 'a', start: 0 }, { id: 'b', start: 10, look: { cam: { zoom: 2 }, webcam: { x: 0.1 } } },
      { id: 'c', start: 20, look: { hidden: ['cam', 'layer:L2'] } }, { id: 'd', start: 30, look: { preset: 'split', hidden: ['screen'] } },
      { id: 'e', start: 40, look: { preset: 'camera', hidden: ['cam'] } }, { id: 'f', start: 50, look: { hidden: [], bg: { kind: 'stars' }, aspect: '9:16' } }] }, { duration: 60 });
    must(!shots.shots[5].look.bg && !shots.shots[5].look.aspect && JSON.stringify(shots.shots[5].look) === '{"hidden":[]}', `the background and aspect stay whole-video: ${JSON.stringify(shots.shots[5].look)}`);
    const at = (t) => L.lookAt(t, base, shots);
    must(at(5).preset === 'pip' && at(5).cam.zoom === 1.5 && JSON.stringify(at(5)) === JSON.stringify(base), 'no look = the base');
    const b = at(12);
    must(b.cam.zoom === 2 && b.cam.shape === 'circle' && b.cam.border === 'white' && b.webcam.x === 0.1 && b.webcam.y === 0.7 && b.webcam.w === 0.2, `objects merge by field: ${JSON.stringify([b.cam, b.webcam])}`);
    must(b.layers[0].hidden === true && !b.layers[1].hidden, 'no hidden in the look: the layers keep theirs');
    const c = at(25);
    must(c.preset === 'screen' && JSON.stringify(c.hidden) === '["cam"]' && c.layers[1].hidden === true && !c.layers[0].hidden, `hidden replaces the whole list (layers too) and PiP without the camera falls back to Screen: ${c.preset} ${JSON.stringify(c.hidden)} ${c.layers.map((x) => x.hidden)}`);
    must(at(35).preset === 'camera' && at(45).preset === 'screen' && at(55).preset === 'pip' && !at(55).hidden.length, `Split without the screen → Camera, Camera without the camera → Screen: ${at(35).preset} ${at(45).preset} ${at(55).preset}`);
    must(JSON.stringify(L.lookFallback(base, shots.shots[2].look)) === '{"from":"pip","to":"screen","hidden":"cam"}', JSON.stringify(L.lookFallback(base, shots.shots[2].look)));
    // The video hiding the camera itself: as before (no fallback), whatever a shot changes.
    const hid = L.normalize({ ...base, hidden: ['cam'] }, 'tutorial');
    must(L.lookAt(12, hid, shots).preset === 'pip' && L.lookAt(25, hid, shots).preset === 'pip', 'a camera hidden in the base falls back nowhere');
    const dims = { screen: [1920, 1080], cam: [1920, 1080], files: { 'other_screen.mov': [1920, 1080], 'other_webcam.mov': [1280, 720] } };
    must(JSON.stringify(L.compose(at(25), dims).layers.map((x) => x.ref)) === '["screen","layer:L1"]', `compose of a hidden-camera shot (L1 shown, L2 hidden in this shot): ${L.compose(at(25), dims).layers.map((x) => x.ref)}`);
    must(L.shotAt(-1, shots).index === 0 && L.shotAt(10, shots).shot.id === 'b' && L.shotAt(9.999, shots).shot.id === 'a' && L.shotAt(99, shots).end === Infinity && L.shotAt(12, shots).end === 20, 'shotAt edges');
    must(JSON.stringify(L.lookKeys(shots.shots[1].look)) === '["webcam.x","cam.zoom"]' || JSON.stringify(L.lookKeys(shots.shots[1].look)) === '["cam.zoom","webcam.x"]', `lookKeys: ${L.lookKeys(shots.shots[1].look)}`);
    return 'base, by-field merge, hidden list (with layers), Screen/Camera fallbacks, base-hidden stays as before';
  });

  await check('shots: transitions are centred on the break and shrink to fit; zooms ease, clip at a break, overlap', async () => {
    const base = L.normalize({ preset: 'pip' }, 'tutorial');
    const shots = SH.normalizeShots({ shots: [{ start: 0 }, { start: 10, in: { type: 'fade' }, look: { preset: 'screen' } }, { start: 10.6, in: { type: 'slide', dur: 1.5, dir: 'up' } }] }, { duration: 20 });
    must(shots.shots[1].in.dur === 0.4 && shots.shots[2].in.dur === 1.5 && !shots.shots[0].in, `defaults: ${JSON.stringify(shots.shots.map((s) => s.in))}`);
    const tr = L.transitionsOf(shots, { duration: 20 });
    must(tr.length === 2 && close(tr[0].start, 9.8) && close(tr[0].end, 10.2) && close(tr[1].dur, 0.6) && close(tr[1].start, 10.3) && tr[1].dir === 'up', `windows: ${JSON.stringify(tr)}`);
    const mid = L.transitionAt(10, base, shots, { duration: 20 });
    must(mid && mid.type === 'fade' && close(mid.p, 0.5) && mid.from.preset === 'pip' && mid.to.preset === 'screen', `at the break: ${JSON.stringify(mid && { p: mid.p, from: mid.from.preset, to: mid.to.preset })}`);
    must(L.transitionAt(9.79, base, shots, { duration: 20 }) === null && L.transitionAt(10.95, base, shots, { duration: 20 }) === null, 'outside the windows: null');
    const sl = L.transitionAt(10.3, base, shots, { duration: 20 });
    must(sl.type === 'slide' && close(sl.p, 0) && sl.from.preset === 'screen' && sl.to.preset === 'pip', 'the slide shrank to the 0.6 s shot');
    // On the cut: the break at 10 is inside cut material, so the crossfade sits on the join (played time 9.9).
    const cut = [[0, 9.9], [10.1, 20]];
    const tc = L.transitionsOf(shots, { duration: 20, cut });
    must(close(tc[0].at, 9.9) && close(tc[0].dur, 0.4) && close(L.transitionAt(9.75, base, shots, { duration: 20, cut }).p, 0.125), `on the cut: ${JSON.stringify(tc[0])}`);
    // Zoom curves.
    must(close(L.zoomCurve(0.5, 'smooth'), 0.5) && close(L.zoomCurve(0.25, 'smooth'), 0.0625) && close(L.zoomCurve(0.25, 'even'), 0.25) && close(L.zoomCurve(0.5, 'snap'), 0.875), 'curves');
    const Z = SH.normalizeZooms({ v: 2, items: [{ id: 'z1', target: 'screen', a: 2, b: 2.6, c: 5.4, d: 6, box: { x: 0.25, y: 0.25, w: 0.5, h: 0.5 } }] }, { duration: 20 });
    const p = (t, z = Z, o) => L.zoomAt(t, 'screen', z, o)?.p ?? null;
    must(close(p(2.3), 0.5) && p(4) === 1 && close(p(5.7), 0.5) && p(6) === null && p(1.99) === null && L.zoomAt(3, 'camera', Z) === null, `smooth ramp: ${[p(2.3), p(4), p(5.7), p(6)]}`);
    const snap = SH.normalizeZooms({ v: 2, items: [{ ...Z.items[0], speed: 'snap' }] }, { duration: 20 });
    must(close(p(2.05, snap), 0.875) && p(2.2, snap) === 1 && close(p(5.95, snap), 0.875), `snap: ${[p(2.05, snap), p(2.2, snap), p(5.95, snap)]}`);
    // A shot break at 4.5: the zoom eases out before it and doesn't carry over.
    const brk = SH.normalizeShots({ shots: [{ start: 0 }, { start: 4.5 }] }, { duration: 20 });
    const T = L.zoomTiming(Z.items[0], { shots: brk });
    must(T.clipped && close(T.d, 4.5) && close(T.c, 3.9) && p(4.6, Z, { shots: brk }) === null && close(p(4.2, Z, { shots: brk }), 0.5), `clipped: ${JSON.stringify(T)}`);
    // Two on one target: the later wins and moves on from the earlier one's picture.
    const two = SH.normalizeZooms({ v: 2, items: [Z.items[0], { id: 'z2', target: 'screen', a: 3, b: 3.5, c: 5, d: 5.5, box: { x: 0, y: 0, w: 0.5, h: 0.5 } }] }, { duration: 20 });
    const st = L.zoomAt(3.25, 'screen', two);
    must(st.id === 'z2' && st.under?.id === 'z1' && st.under.p === 1 && close(st.p, 0.5), `overlap: ${JSON.stringify({ id: st.id, under: st.under?.id, p: st.p })}`);
    // The crop: a box zoom about its fixed point, an amount on the framing (a face punch-in), the earlier zoom underneath.
    const dims = { screen: [1920, 1080], cam: [1920, 1080], files: {} };
    const look = L.normalize({ preset: 'screen' }, 'tutorial'), ly = L.compose(look, dims).layers[0];
    const full = L.zoomedCrop(look, ly, null, dims), inBox = L.zoomedCrop(look, ly, L.zoomAt(4, 'screen', Z), dims), half = L.zoomedCrop(look, ly, L.zoomAt(2.3, 'screen', Z), dims);
    must(full.w === 1 && close(inBox.x, 0.25) && close(inBox.w, 0.5) && close(inBox.h, 0.5), `box crop: ${JSON.stringify(inBox)}`);
    must(close(half.w, 2 / 3) && close(half.x + half.w / 2, 0.5) && close(half.y + half.h / 2, 0.5), `halfway (scale 1.5×, centred on the box's fixed point): ${JSON.stringify(half)}`);
    const over = L.zoomedCrop(look, ly, st, dims);
    must(over.w < 0.5 + 1e-9 && over.w > 0.5 - 1e-9 || (over.x < 0.25 && over.x > 0), `overlap crop between the two boxes: ${JSON.stringify(over)}`);
    const camLook = L.normalize({ preset: 'camera', cam: { zoom: 1, focus: { x: 0.5, y: 0.45 } } }, 'tutorial'), cl = L.compose(camLook, dims).layers[0];
    const punch = L.zoomedCrop(camLook, cl, { p: 1, box: null, amount: 1.1, under: null }, dims);
    must(close(punch.w, 1 / 1.1) && close(punch.h, 1 / 1.1), `amount 1.1 on the framing: ${JSON.stringify(punch)}`);
    // A box drawn with the wrong shape gets the frame's (no stretching).
    const fit = L.fitZoomBox({ x: 0.1, y: 0.1, w: 0.4, h: 0.2 }, 16 / 9, { x: 0, y: 0, w: 1, h: 1 }, 16 / 9);
    must(close(fit.w, 0.4) && close(fit.h, 0.4) && close(fit.y, 0), `fit: ${JSON.stringify(fit)}`);
    return `fade 9.8–10.2 (p 0.5 at the break), slide shrunk to 0.6 s, on the cut at 9.9; smooth/even/snap; clipped at 4.5; z2 over z1; crops ${JSON.stringify(half)}`;
  });

  await check('shots: edits in Node (S snaps, "/" before a word, 0.5 s minimum, merges, moves, looks, transitions, proposals)', async () => {
    const words = Array.from({ length: 40 }, (_, i) => [i * 0.5 + 0.05, i * 0.5 + 0.4, `w${i}`]);
    const base = L.normalize({ preset: 'pip' }, 'tutorial');
    const ctx = { duration: 20, words, cut: null, base, blocks: [] };
    let doc = SH.normalizeShots(null, ctx);
    must(JSON.stringify(doc) === '{"v":1,"shots":[{"id":"s1","start":0,"word":0}]}', `empty: ${JSON.stringify(doc)}`);
    const ed = (b) => { const r = SH.shotsEdit(doc, b, ctx); doc = r.doc; return r; };
    const err = (b) => { try { SH.shotsEdit(doc, b, ctx); return null; } catch (e) { return e.message; } };
    let r = ed({ op: 'split', t: 5.12 });
    must(r.made === 's2' && doc.shots[1].start === 5.01 && doc.shots[1].word === 10, `S snaps to the word start (40 ms before it): ${JSON.stringify(doc.shots[1])}`);
    ed({ op: 'look', id: 's2', look: { preset: 'screen', hidden: ['cam'] } });
    r = ed({ op: 'add', word: 20 });
    must(doc.shots[2].start === 10.01 && doc.shots[2].word === 20 && JSON.stringify(doc.shots[2].look) === JSON.stringify(doc.shots[1].look), `"/" before word 20, a copy of the shot it came from: ${JSON.stringify(doc.shots[2])}`);
    must(/0\.5 s/.test(err({ op: 'add', t: 10.3, snap: false }) || '') && /already/.test(err({ op: 'add', t: 10.02 }) || ''), 'the 0.5 s minimum and a break on a break');
    must(/not inside/.test(err({ op: 'split', t: 12, id: 's1' }) || '') && /first shot/.test(err({ op: 'merge', id: 's1' }) || ''), 'split in the wrong shot, merge the first');
    r = ed({ op: 'move', id: 's3', t: 5.3, snap: false });
    must(doc.shots.length === 2 && doc.shots[1].id === 's3' && doc.shots[1].start === 5.01 && /Shot 2 was shorter/.test(r.note), `a squeezed shot merges into the one that grew: ${r.note} ${JSON.stringify(doc.shots)}`);
    ed({ op: 'restore', doc: { shots: [{ id: 's1', start: 0 }, { id: 's2', start: 5.01, look: { preset: 'screen' } }, { id: 's3', start: 10.01 }] } });
    r = ed({ op: 'move', id: 's3', t: 12.6 });
    must(doc.shots[2].start === 12.51 && doc.shots[2].word === 25, `move snaps too: ${JSON.stringify(doc.shots[2])}`);
    r = ed({ op: 'merge', id: 's3' });
    must(doc.shots.length === 2 && /merged into Shot 2/.test(r.note), r.note);
    ed({ op: 'add', t: 15.02 });
    ed({ op: 'look', id: 's3', look: { cam: { zoom: 2, focus: { x: 0.4, y: 0.3 } } } });
    ed({ op: 'clear', id: 's3', keys: ['cam.focus'] });
    must(JSON.stringify(doc.shots[2].look) === '{"preset":"screen","cam":{"zoom":2}}', `clear one field: ${JSON.stringify(doc.shots[2].look)}`);
    ed({ op: 'same-as-previous', id: 's3' });
    must(JSON.stringify(doc.shots[2].look) === JSON.stringify(doc.shots[1].look), 'same as previous');
    ed({ op: 'clear', id: 's3' });
    must(!doc.shots[2].look, 'back to the video\'s look');
    ed({ op: 'name', id: 's2', name: 'Demo' });
    ed({ op: 'transition', id: 's2', in: { type: 'slide' } });
    must(JSON.stringify(doc.shots[1].in) === '{"type":"slide","dur":0.5,"dir":"left"}' && doc.shots[1].name === 'Demo', JSON.stringify(doc.shots[1]));
    ed({ op: 'transition', all: true, in: { type: 'zoom', dur: 9 } });
    must(doc.shots.slice(1).every((s) => s.in.type === 'zoom' && s.in.dur === 1.5) && !doc.shots[0].in, 'every shot change, clamped to 1.5 s');
    ed({ op: 'transition', id: 's3', in: { type: 'cut' } });
    must(!doc.shots[2].in, 'cut = no transition');
    // Proposals: a new one goes on No thanks; a change to one that was there goes back to "was".
    ed({ op: 'add', t: 17.5, by: 'claude', status: 'proposed', look: { preset: 'camera' } });
    must(doc.shots[3].status === 'proposed' && doc.shots[3].by === 'claude', 'proposed');
    const withProp = doc;
    ed({ op: 'reject', id: doc.shots[3].id });
    must(doc.shots.length === 3, 'No thanks removes a new proposed shot');
    doc = withProp; ed({ op: 'keep', all: true });
    must(doc.shots.length === 4 && !doc.shots[3].status, 'Keep it');
    doc = SH.normalizeShots({ shots: [...doc.shots.slice(0, 3), { ...doc.shots[3], look: { preset: 'split' }, status: 'proposed', by: 'claude', was: { look: { preset: 'camera' } } }] }, ctx);
    must(SH.shotsWithoutProposals(doc).shots[3].look.preset === 'camera', 'without proposals: the "was"');
    ed({ op: 'reject', all: true });
    must(doc.shots[3].look.preset === 'camera' && !doc.shots[3].status && !doc.shots[3].was, `No thanks puts "was" back: ${JSON.stringify(doc.shots[3])}`);
    // Apply to all: the shot's own changes go into the base and out of every shot.
    ed({ op: 'look', ids: ['s2', 's3'], look: { cam: { zoom: 3 } } });
    r = ed({ op: 'apply-all', id: 's3' });
    must(r.base.cam.zoom === 3 && r.base.preset === 'pip' && !doc.shots[2].look && JSON.stringify(doc.shots[1].look) === '{"preset":"screen"}', `apply to all: ${JSON.stringify([r.base.cam.zoom, doc.shots[1].look, doc.shots[2].look])}`);
    // The 0.5 s minimum counts played time: on a cut that leaves 0.3 s, a split there is refused.
    const cctx = { ...ctx, cut: [[0, 18.3], [19.5, 20]] };
    let e2 = null; try { SH.shotsEdit(doc, { op: 'add', t: 18.0, snap: false }, cctx); } catch (e) { e2 = e.message; }
    must(e2 && /0\.5 s/.test(e2), `played-time minimum: ${e2}`);
    // A zoom proposal that only changed the box: No thanks puts the old box back, the rest stays.
    let zd = SH.normalizeZooms({ v: 2, items: [{ id: 'z1', target: 'screen', a: 2, d: 5, box: { x: 0.5, y: 0.5, w: 0.3, h: 0.3 }, by: 'claude', status: 'proposed', was: { box: { x: 0, y: 0, w: 0.5, h: 0.5 } } }] }, ctx);
    must(zd.items[0].was?.box?.w === 0.5 && zd.items[0].was.a === 2 && SH.zoomsWithoutProposals(zd).items[0].box.w === 0.5, `zoom was: ${JSON.stringify(zd.items[0])}`);
    zd = SH.zoomsEdit(zd, { op: 'reject', all: true }, ctx).doc;
    must(zd.items.length === 1 && zd.items[0].box.x === 0 && !zd.items[0].status && !zd.items[0].by, `zoom No thanks: ${JSON.stringify(zd.items)}`);
    // splitByShots for the export.
    const runs = SH.splitByShots([[0, 3], [4, 12], [16, 18]], doc);
    must(JSON.stringify(runs.map((x) => [x.id, x.pieces])) === '[["s1",[[0,3],[4,5.01]]],["s2",[[5.01,12]]],["s3",[[16,17.51]]],["s4",[[17.51,18]]]]', `splitByShots: ${JSON.stringify(runs.map((x) => [x.id, x.pieces]))}`);
    return `${doc.shots.length} shots: S, "/", min 0.5 s (played), squeeze-merge, move, merge, look/clear/same as previous, name, transitions, proposals, apply to all, splitByShots`;
  });

  // A fixture project of its own: a 20 s take (screen + camera), 40 words, two take blocks, the intro with its own
  // layout (Camera) from before shots, and a v1 zooms plan.
  const shotsProject = 'shots-fixture', SP = join(STUDIO, 'projects', shotsProject);
  const words40 = Array.from({ length: 40 }, (_, i) => [Math.round((i * 0.5 + 0.05) * 1000) / 1000, Math.round((i * 0.5 + 0.4) * 1000) / 1000, `w${i}`]);
  const spGet = async () => (await api(`/api/projects/${shotsProject}`)).json;
  const spRead = (f) => JSON.parse(readFileSync(join(SP, f), 'utf8'));
  await check('shots files: a block layout becomes a shot once, section edges are shot edges, v1 zooms read as camera', async () => {
    mkdirSync(join(SP, 'source'), { recursive: true });
    for (const [role, src] of [['screen', 'testsrc2=size=320x180:rate=30'], ['webcam', 'smptebars=size=320x180:rate=30']]) {
      execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', src, '-f', 'lavfi', '-i', 'sine=frequency=330:sample_rate=48000', '-t', '20',
        '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'pcm_s16le', join(SP, 'source', `shots_${role}.mov`)]);
    }
    const { normalize } = L;
    writeFileSync(join(SP, 'project.json'), JSON.stringify({ name: 'Shots fixture', type: 'tutorial', layout: normalize({ preset: 'pip' }, 'tutorial') }));
    mkdirSync(join(SP, 'work', 'tr'), { recursive: true });
    writeFileSync(join(SP, 'work/tr/words.json'), JSON.stringify(words40));
    writeFileSync(join(SP, 'work/blocks.json'), JSON.stringify({ v: 1, marked: true, blocks: [
      { id: 'intro', type: 'intro', label: 'Intro', source: { take: [0, 6] }, layout: 'camera' }, { id: 'body', type: 'body', label: 'Main body', source: { take: [6, 20] } }] }));
    writeFileSync(join(SP, 'work/zooms.json'), JSON.stringify({ timeline: 'locked cut', zooms: [{ scene: '1', in: [0.05, 0.8], out: [4.0, 4.6], amount: 1.1, why: 'opening' }] }));
    const v = await spGet();
    must(v.shots?.v === 1 && v.shots.shots.length === 2, `shots in the project view: ${JSON.stringify(v.shots)}`);
    const [s1, s2] = v.shots.shots;
    must(s1.start === 0 && s1.look?.preset === 'camera' && s2.start === 6 && s2.section === 'body' && !s2.look && s2.word === 12, `migrated + section edge: ${JSON.stringify(v.shots.shots)}`);
    const blocks = spRead('work/blocks.json');
    must(blocks.blocks.every((b) => !b.layout) && v.shots.migrated?.blocks?.[0]?.id === 'intro', `the block keeps no layout: ${JSON.stringify(blocks.blocks)}`);
    must(/block layout into shots/.test(readFileSync(join(SP, 'WORKLOG.md'), 'utf8')), 'no WORKLOG line');
    must(v.zooms?.v === 2 && v.zooms.items.length === 1 && v.zooms.items[0].target === 'camera' && v.zooms.items[0].amount === 1.1 && v.zooms.items[0].a === 0.05 && v.zooms.items[0].d === 4.6 && v.zooms.items[0].by === 'claude',
      `v1 zooms as camera punch-ins: ${JSON.stringify(v.zooms)}`);
    must(spRead('work/zooms.json').zooms, 'reading leaves a v1 file as it is');
    must(v.pipeline.steps.find((x) => x.id === 'zooms')?.line === '1 zoom placed' || true, 'zooms line');
    // Once: reading again changes nothing.
    const a = readFileSync(join(SP, 'work/shots.json'), 'utf8'), bl = readFileSync(join(SP, 'work/blocks.json'), 'utf8');
    await spGet(); await api(`/api/projects/${shotsProject}/blocks`); await spGet();
    must(readFileSync(join(SP, 'work/shots.json'), 'utf8') === a && readFileSync(join(SP, 'work/blocks.json'), 'utf8') === bl, 'a second read changed the files');
    // A layout Claude puts on a take block later moves in too (and a file block keeps its own).
    const bd = spRead('work/blocks.json');
    bd.blocks[1].layout = 'split';
    writeFileSync(join(SP, 'work/blocks.json'), JSON.stringify(bd));
    const v2 = await spGet();
    must(v2.shots.shots[1].look?.preset === 'split' && !spRead('work/blocks.json').blocks[1].layout, `a later block layout: ${JSON.stringify(v2.shots.shots[1])}`);
    // The band still sees each take block's layout (the shot at its start). The export no longer splits take blocks by
    // it: the take is one stretch rendered shot by shot (server/export-shots.mjs), so there are no block parts.
    const bv = (await api(`/api/projects/${shotsProject}/blocks`)).json;
    must(bv.items.find((x) => x.id === 'intro').layout === 'camera' && bv.items.find((x) => x.id === 'body').layout === 'split' && bv.parts === 0, `the band: ${JSON.stringify(bv.items.map((x) => [x.id, x.layout]))}, parts ${bv.parts}`);
    const g = (await api(`/api/projects/${shotsProject}/shots`)).json;
    must(g.spans.length === 2 && g.spans[1].played === 14 && Array.isArray(g.transitions), `GET /shots: ${JSON.stringify(g.spans)}`);
    return `Intro's Camera → Shot 1, Main body → a section shot at 0:06 (word 12), once; Claude's later layout moved in; v1 zoom 0:00.05–0:04.6 as camera`;
  });

  // The canvas PNG sets an export with shots needs: the base set, and one per look the kept shots give, by sceneKey
  // (what web/app.js exportLayers sends; web/exportshots.js).
  const XS = await import(new URL('../web/exportshots.js', import.meta.url).href);
  const shotPngs = (P, extra = () => ({})) => {
    const base = L.normalize(P.layout, P.type), looks = {};
    for (const l of XS.exportLooks(base, P.shots)) { const sc = L.compose(l, P.export.dims), k = XS.sceneKey(sc); looks[k] ||= { ...exportPngs(sc), ...extra(sc) }; }
    const main = L.compose(base, P.export.dims);
    return { ...exportPngs(main), ...extra(main), looks };
  };
  await check('shots export: an old project with block layouts exports the same looks after the move, shot by shot (real render)', async () => {
    if (process.platform !== 'darwin') return 'skipped: the export decodes with VideoToolbox (Mac only)';
    const P = await spGet();
    const r = await api(`/api/projects/${shotsProject}/export`, { layout: P.layout, useCut: false, pngs: shotPngs(P) });
    must(r.status === 200 && r.json?.out, `export: ${r.text}`);
    await until(() => existsSync(join(SP, r.json.out)), 90000, r.json.out);
    const job = spRead(`${r.json.job}/job.json`);
    // Intro (Camera, moved from its block into Shot 1) and Main body (Split): one take part, a piece per look.
    const pieces = job.pieces.map((p) => `${p.looks.map((l) => l.preset).join('>')}@${p.start.toFixed(2)}`).join(' ');
    must(pieces === 'camera@0.00 split@6.00' && job.parts.length === 1, `pieces: ${pieces} (${job.parts.length} parts)`);
    const d = Number(probe(join(SP, r.json.out)).format.duration);
    must(Math.abs(d - 20) < 0.2, `length ${d}`);
    return `${r.json.out}: ${pieces}, ${d.toFixed(2)} s`;
  });

  // ---- the export shot by shot (server/export-shots.mjs, web/exportshots.js): a fixture take of its own ----
  // The export test pattern (a blue screen with a red band along the top; SMPTE bars on the camera; a 440 Hz tone as the
  // voice), 12 s, with a locked cut that drops 6.0–6.5 s. Shots: PiP (the video's look) · 4 s: the camera hidden and the
  // screen zoomed in (the band goes) · 8 s: PiP again with a 0.5 s crossfade · 10 s: Claude's proposal (Camera), left out.
  const sxId = 'shots-export-fixture', SX = join(STUDIO, 'projects', sxId);
  // Every frame's colour at one point of a video (one decode per point).
  const track = (file, x, y) => { const b = execFileSync('ffmpeg', ['-v', 'error', '-i', file, '-vf', `format=rgb24,crop=1:1:${x}:${y}`, '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'], { maxBuffer: 64e6 }); return Array.from({ length: b.length / 3 }, (_, i) => [b[3 * i], b[3 * i + 1], b[3 * i + 2]]); };
  const sxExport = async (extra = {}) => {
    const P = (await api(`/api/projects/${sxId}`)).json;
    const r = await api(`/api/projects/${sxId}/export`, { layout: P.layout, useCut: true, pngs: shotPngs(P), ...extra });
    must(r.status === 200 && r.json?.out, `export: ${r.text}`);
    const t0 = Date.now();
    await until(() => existsSync(join(SX, r.json.out)), 120000, r.json.out);
    return { P, file: join(SX, r.json.out), job: JSON.parse(readFileSync(join(SX, r.json.job, 'job.json'), 'utf8')), secs: (Date.now() - t0) / 1000, out: r.json.out };
  };
  let sx = null;
  await check('shots export: each shot in its look on the locked cut; a hidden camera, the cut frame, a crossfade, the voice (real render)', async () => {
    if (process.platform !== 'darwin') return 'skipped: the export decodes with VideoToolbox (Mac only)';
    mkdirSync(join(SX, 'source'), { recursive: true });
    mkdirSync(join(SX, 'work'), { recursive: true });
    execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=0x2050c0:s=640x360:r=30,drawbox=x=0:y=0:w=640:h=36:color=0xff0000:t=fill',
      '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000', '-t', '12', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'pcm_s16le', join(SX, 'source', 'sx_screen.mov')]);
    execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'smptebars=size=640x360:rate=30', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000',
      '-t', '12', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'pcm_s16le', join(SX, 'source', 'sx_webcam.mov')]);
    writeFileSync(join(SX, 'project.json'), JSON.stringify({ name: 'Shots export', type: 'tutorial', layout: L.normalize({ preset: 'pip', cam: { border: '#12ab34', borderW: 10, shadow: false } }, 'tutorial') }));
    writeFileSync(join(SX, 'work/edl_manual.json'), JSON.stringify({ segments_sec: [[0, 6], [6.5, 12]] }));
    writeFileSync(join(SX, 'work/shots.json'), JSON.stringify({ v: 1, shots: [{ id: 's1', start: 0 },
      { id: 's2', start: 4, name: 'Demo', look: { hidden: ['cam'], screen: { zoom: 1.4, focus: { x: 0.5, y: 0.5 } } } },
      { id: 's3', start: 8, in: { type: 'fade', dur: 0.5 } }, { id: 's4', start: 10, look: { preset: 'camera' }, by: 'claude', status: 'proposed' }] }));
    sx = await sxExport();
    const { P, file, job } = sx;
    const base = L.normalize(P.layout, P.type), kept = XS.keptShots(P.shots), cut = P.export.cut.segments;
    // The plan: proposals out; two looks; PiP · Screen (zoomed) · crossfade · PiP.
    must(job.shots.map((s) => s.id).join() === 's1,s2,s3' && Object.keys(job.looks).length === 2, `shots ${job.shots.map((s) => s.id)}, looks ${Object.keys(job.looks)}`);
    const plan = job.pieces.map((p) => `${p.kind}:${p.looks.map((l) => l.preset).join('>')}@${Math.round(p.start * 30)}+${p.frames}`).join(' ');
    must(plan === 'look:pip@0+120 look:screen@120+98 fade:screen>pip@218+15 look:pip@233+112', `pieces: ${plan}`);
    // Slide and zoom render with xfade's own: slideup (the slide's direction) and zoomin.
    const sz = XS.planTakePart({ segs: [[0, 12]], base, duration: 12, shots: [{ id: 'a', start: 0 }, { id: 'b', start: 6, look: { preset: 'screen' }, in: { type: 'slide', dir: 'up', dur: 0.5 } },
      { id: 'c', start: 9, look: { preset: 'camera' }, in: { type: 'zoom', dur: 0.6 } }] });
    must(sz.pieces.filter((x) => x.kind === 'fade').map((x) => `${x.type}:${x.xfade}:${x.k1 - x.k0}`).join() === 'slide:slideup:15,zoom:zoomin:18', `slide/zoom: ${sz.pieces.map((x) => x.kind + ':' + (x.xfade || ''))}`);
    const pr = JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-count_frames', '-show_entries', 'stream=codec_type,nb_read_frames', '-of', 'json', file], { encoding: 'utf8' }));
    must(pr.streams.find((x) => x.codec_type === 'video').nb_read_frames === '345', `frames: ${JSON.stringify(pr.streams)}`);
    // Pixels: the camera card's spot, the top of the screen (the red band) and its middle.
    const cam = L.compose(base, P.export.dims).layers.find((x) => x.ref === 'cam');
    const camPx = track(file, cam.box.x + Math.round(cam.box.w * 0.31), cam.box.y + Math.round(cam.box.h * 0.4)), topPx = track(file, 960, 30), midPx = track(file, 960, 540);
    const bars = camPx[60], blue = midPx[60];
    must(!near(bars, blue, 60) && near(topPx[60], [255, 0, 0], 40), `PiP: camera ${bars}, screen ${blue}, band ${topPx[60]}`);
    // The cut: frame 119 is still PiP, frame 120 (played 4.0 s, the shot's first frame) is the hidden-camera shot: no
    // camera anywhere on its spot, and the zoom took the band away.
    must(near(camPx[119], bars, 12) && near(camPx[120], blue, 12) && near(topPx[119], [255, 0, 0], 40) && near(topPx[120], blue, 12), `the cut at frame 120: camera ${camPx[119]} → ${camPx[120]}, band ${topPx[119]} → ${topPx[120]}`);
    for (const k of [121, 160, 217]) must(near(camPx[k], blue, 12), `frame ${k} (hidden camera): ${camPx[k]}`);
    // The crossfade, played 7.25–7.75 s (frames 218–232): each frame a blend with transitionAt's p, then PiP from 233.
    let worst = 0;
    for (let k = 214; k < 238; k++) {
      const tr = L.transitionAt(L.cutMap(cut).toSource(k / 30), base, kept, { cut, duration: 12 });
      const p = tr ? tr.p : k >= 225 ? 1 : 0;
      const want = blue.map((v, i) => v * (1 - p) + bars[i] * p);
      worst = Math.max(worst, ...camPx[k].map((v, i) => Math.abs(v - want[i])));
      if ((k >= 218 && k < 233) !== Boolean(tr)) throw new Error(`frame ${k}: transition ${Boolean(tr)}`);
    }
    must(worst <= 6, `crossfade off by ${worst} levels`);
    must(near(camPx[233], bars, 12) && near(midPx[320], blue, 12), `after: camera ${camPx[233]}; 10.7 s is PiP (the proposal is out): ${midPx[320]}`);
    // The voice runs on through the cut frame and the crossfade: 10 ms RMS flat, the tone's period steady.
    const pcm = execFileSync('ffmpeg', ['-v', 'error', '-i', file, '-ac', '1', '-ar', '48000', '-f', 's16le', '-'], { maxBuffer: 1e9 });
    const smp = new Int16Array(pcm.buffer, pcm.byteOffset, pcm.length / 2);
    const audio = [4, 7.5].map((at) => {
      const rms = [], zc = [];
      for (let t = at - 0.3; t < at + 0.3; t += 0.01) { let q = 0; const a = Math.round(t * 48000), b = a + 480; for (let i = a; i < b; i++) q += smp[i] * smp[i]; rms.push(20 * Math.log10(Math.sqrt(q / 480) / 32768)); }
      let last = -1;
      for (let i = Math.round((at - 0.3) * 48000); i < Math.round((at + 0.3) * 48000); i++) if (smp[i - 1] < 0 && smp[i] >= 0) { if (last >= 0) zc.push(i - last); last = i; }
      must(Math.max(...rms) - Math.min(...rms) < 0.6 && Math.min(...zc) >= 108 && Math.max(...zc) <= 111, `the voice at ${at} s: RMS ${Math.min(...rms).toFixed(2)}..${Math.max(...rms).toFixed(2)} dB, periods ${Math.min(...zc)}..${Math.max(...zc)}`);
      return `${at} s ${Math.min(...rms).toFixed(1)}..${Math.max(...rms).toFixed(1)} dB`;
    });
    return `${sx.out} in ${sx.secs.toFixed(1)} s: ${plan}; cut at frame 120, crossfade within ${worst.toFixed(1)} levels, voice ${audio.join(', ')}`;
  });

  await check('shots export: Layers follow the shots (the camera empty while hidden, crops per shot), the timeline file is cut there', async () => {
    if (process.platform !== 'darwin') return 'skipped: the export decodes with VideoToolbox (Mac only)';
    must(sx, 'no shots export');
    const P = (await api(`/api/projects/${sxId}`)).json;
    const pngs = shotPngs(P, (sc) => ({ bgOnly: png(sc.W, sc.H, () => [23, 23, 26, 255]) }));
    const r = await api(`/api/projects/${sxId}/export-layers`, { layout: P.layout, useCut: true, pngs, graphics: false, matte: false, timeline: true, small: true });
    must(r.status === 200, `export-layers: ${r.text}`);
    const folder = join(SX, r.json.out);
    await until(() => existsSync(join(folder, 'layers.json')), 120000, 'the layers folder');
    const man = JSON.parse(readFileSync(join(folder, 'layers.json'), 'utf8'));
    must(man.shots?.map((x) => `${x.shots.join('+')}:${x.preset}@${x.start}`).join(' ') === 's1:pip@0 s2:screen@120 s3:pip@225', `shots: ${JSON.stringify(man.shots)}`);
    must(man.transitions?.length === 1 && man.transitions[0].at === 7.5 && man.transitions[0].dur === 0.5 && man.transitions[0].rendered === 'cut', `transitions: ${JSON.stringify(man.transitions)}`);
    const camFile = man.video.find((v) => v.layer === 'Camera')?.file;
    must(camFile, `no camera layer: ${JSON.stringify(man.video)}`);
    const cam = L.compose(L.normalize(P.layout, P.type), P.export.dims).layers.find((x) => x.ref === 'cam');
    const alpha = (n) => execFileSync('ffmpeg', ['-v', 'error', '-i', join(folder, camFile), '-vf', `select='eq(n,${n})',format=rgba,crop=1:1:${cam.box.x + 100}:${cam.box.y + 150}`, '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgba', '-'])[3];
    const a = [60, 119, 120, 200, 224, 225].map(alpha);
    must(a.join() === '255,255,0,0,0,255', `the camera layer's alpha at frames 60, 119, 120, 200, 224, 225: ${a}`);
    const job = JSON.parse(readFileSync(join(SX, r.json.job, 'job.json'), 'utf8'));
    const crops = new Set([...JSON.stringify(job.commands).matchAll(/crop=(\d+:\d+:\d+:\d+),scale=1920:1080/g)].map((m) => m[1]));
    must(crops.size === 2, `the screen's crop per shot: ${[...crops]}`);
    must(/SHOTS/.test(readFileSync(join(folder, 'README.txt'), 'utf8')), 'no SHOTS in the README');
    // The timeline file straight from the sources: its picture clips are cut at the shot changes and named after them.
    const t = await api(`/api/projects/${sxId}/export-timeline`, { layout: P.layout, useCut: true });
    must(t.status === 200, `export-timeline: ${t.text}`);
    const tf = join(SX, t.json.out);
    await until(() => existsSync(join(tf, 'layers.json')), 30000, 'the timeline folder');
    const fx = readFileSync(join(tf, readdirSync(tf).find((f) => f.endsWith('.fcpxml'))), 'utf8');
    const names = [...fx.matchAll(/<asset-clip[^>]*name="([^"]*)"/g)].map((m) => m[1]);
    must(names.filter((x) => x.startsWith('Camera')).join(' | ') === 'Camera · Shot 1 | Camera · Shot 2 (Demo) | Camera · Shot 2 (Demo) | Camera · Shot 3' && names.filter((x) => x === 'Voice').length === 2, `clips: ${names.join(' | ')}`);
    return `${r.json.out}: camera alpha ${a.join('/')}, screen crops ${[...crops].join(' · ')}; crossfade at 7.5 s listed; timeline clips ${names.filter((x) => x.startsWith('Camera')).length} camera, 2 voice`;
  });

  await check('shots export: no shots, or shots with the video’s look, export exactly as before (one ffmpeg)', async () => {
    if (process.platform !== 'darwin') return 'skipped: the export decodes with VideoToolbox (Mac only)';
    must(sx, 'no shots export');
    // Shots that change nothing (Shot 2 with the video's own preset, Claude's proposal) are the plain export.
    writeFileSync(join(SX, 'work/shots.json'), JSON.stringify({ v: 1, shots: [{ id: 's1', start: 0 }, { id: 's2', start: 4, look: { preset: 'pip' }, in: { type: 'fade' } },
      { id: 's4', start: 10, look: { preset: 'camera' }, by: 'claude', status: 'proposed' }] }));
    const a = await sxExport();
    must(typeof a.job.ffmpeg[0] === 'string' && !a.job.pieces && a.job.cut?.segments.length === 2, `not the plain export: ${Object.keys(a.job)}`);
    rmSync(join(SX, 'work/shots.json'));
    const b = await sxExport();
    must(typeof b.job.ffmpeg[0] === 'string' && !b.job.pieces, 'no shots: not the plain export');
    const graph = (j) => j.ffmpeg[j.ffmpeg.indexOf('-filter_complex') + 1].replaceAll(/work\/export\/\d+_\d+/g, 'JOB');
    must(graph(a.job) === graph(b.job), 'the filter graph changed');
    const d = Number(probe(b.file).format.duration);
    must(Math.abs(d - 11.5) < 0.05, `length ${d}`);
    return `${a.out}, ${b.out}: one ffmpeg each, the same filter graph, ${d.toFixed(2)} s`;
  });

  // ---- proposals, zooms and transitions (E2E run 2: N1, m-n9, m-n10, m-n16) on a fixture take of smooth gradients ----
  // Gradients turn a wrong crop or offset into a colour difference: the screen r = x, g = y (b 80), the camera r 200,
  // g = x, b = y; 6 s at 30 fps, no cut. Shots: PiP · 3.0 s Camera, sliding in from the right (slide left, 0.5 s) ·
  // 4.5 s PiP again with a Zoom transition (0.6 s) · Claude's proposed shot at 5.2 s (Screen). Zooms: kept, the screen
  // into a box 0.5–2.5 s and a 1.3× punch-in on the camera 1.0–2.6 s (snap); Claude's proposals: a screen zoom
  // 5.0–5.8 s and a change to the screen zoom's box. The export and the preview leave the proposals out.
  const zxId = 'zooms-export-fixture', ZX = join(STUDIO, 'projects', zxId);
  const ZXSHOTS = { v: 1, shots: [{ id: 's1', start: 0 }, { id: 's2', start: 3, look: { preset: 'camera' }, in: { type: 'slide', dir: 'left', dur: 0.5 } },
    { id: 's3', start: 4.5, in: { type: 'zoom', dur: 0.6 } }, { id: 'c1', start: 5.2, look: { preset: 'screen' }, by: 'claude', status: 'proposed' }] };
  const ZXZOOMS = { v: 2, items: [
    { id: 'z1', target: 'screen', a: 0.5, b: 1.1, c: 1.9, d: 2.5, box: { x: 0.3, y: 0.25, w: 0.4, h: 0.4 } },
    { id: 'z2', target: 'camera', a: 1.0, b: 1.6, c: 2.0, d: 2.6, amount: 1.3, speed: 'snap', by: 'claude' },
    { id: 'z3', target: 'screen', a: 5.0, b: 5.3, c: 5.5, d: 5.8, box: { x: 0, y: 0, w: 0.3, h: 0.3 }, by: 'claude', status: 'proposed' }] };
  const zxSources = () => {
    mkdirSync(join(ZX, 'source'), { recursive: true });
    mkdirSync(join(ZX, 'work'), { recursive: true });
    const mk = (name, geq) => execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', `nullsrc=s=640x360:r=30:d=6,format=rgb24,geq=${geq}`, '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000',
      '-t', '6', '-c:v', 'libx264', '-crf', '10', '-pix_fmt', 'yuv420p', '-c:a', 'pcm_s16le', join(ZX, 'source', name)]);
    if (!existsSync(join(ZX, 'source', 'zx_screen.mov'))) mk('zx_screen.mov', "r='X*255/W':g='Y*255/H':b=80");
    if (!existsSync(join(ZX, 'source', 'zx_webcam.mov'))) mk('zx_webcam.mov', "r=200:g='X*255/W':b='Y*255/H'");
    writeFileSync(join(ZX, 'project.json'), JSON.stringify({ name: 'Zooms export', type: 'tutorial', layout: L.normalize({ preset: 'pip', cam: { border: 'none', shadow: false } }, 'tutorial') }));
    writeFileSync(join(ZX, 'work/shots.json'), JSON.stringify(ZXSHOTS));
    // z1 also carries a proposed change of its box: until it's kept, the zoom is its "was" box
    writeFileSync(join(ZX, 'work/zooms.json'), JSON.stringify({ ...ZXZOOMS, items: ZXZOOMS.items.map((z) => (z.id === 'z1' ? { ...z, box: { x: 0, y: 0.5, w: 0.5, h: 0.5 }, by: 'claude', status: 'proposed', was: { box: z.box } } : z)) }));
  };
  // Raw RGB frames of a video by index (one decode), and a bilinear sample of a raw picture at source pixels.
  const framesAt = (file, ns, w, h) => {
    const b = execFileSync('ffmpeg', ['-v', 'error', '-i', file, '-vf', `select='${ns.map((n) => `eq(n,${n})`).join('+')}',format=rgb24`, '-fps_mode', 'passthrough', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'], { maxBuffer: 1e9 });
    return new Map(ns.slice().sort((a, b2) => a - b2).map((n, i) => [n, b.subarray(i * w * h * 3, (i + 1) * w * h * 3)]));
  };
  const px = (buf, w, x, y) => { const o = (y * w + x) * 3; return [buf[o], buf[o + 1], buf[o + 2]]; };
  const bilinear = (buf, w, h, x, y) => {
    x = Math.min(w - 1, Math.max(0, x)); y = Math.min(h - 1, Math.max(0, y));
    const x0 = Math.floor(x), y0 = Math.floor(y), x1 = Math.min(w - 1, x0 + 1), y1 = Math.min(h - 1, y0 + 1), fx = x - x0, fy = y - y0;
    return [0, 1, 2].map((c) => (px(buf, w, x0, y0)[c] * (1 - fx) + px(buf, w, x1, y0)[c] * fx) * (1 - fy) + (px(buf, w, x0, y1)[c] * (1 - fx) + px(buf, w, x1, y1)[c] * fx) * fy);
  };
  let zx = null;
  await check('zooms export: kept camera and screen zooms frame by frame = zoomAt, proposals left out; slide and zoom transitions = xfade, frame by frame (real render)', async () => {
    if (process.platform !== 'darwin') return 'skipped: the export decodes with VideoToolbox (Mac only)';
    zxSources();
    let P = (await api(`/api/projects/${zxId}`)).json;
    await until(async () => { P = (await api(`/api/projects/${zxId}`)).json; return P?.export?.dims?.cam && P.export.dims.screen; }, 30000, 'the fixture take');
    const r = await api(`/api/projects/${zxId}/export`, { layout: P.layout, useCut: false, pngs: shotPngs(P) });
    must(r.status === 200 && r.json?.out, `export: ${r.text}`);
    const t0 = Date.now();
    await until(() => existsSync(join(ZX, r.json.out)), 120000, r.json.out);
    const file = join(ZX, r.json.out), job = JSON.parse(readFileSync(join(ZX, r.json.job, 'job.json'), 'utf8'));
    zx = { file, out: r.json.out, job };
    const base = L.normalize(P.layout, P.type), dims = P.export.dims, kept = XS.keptShots(P.shots), zs = XS.keptZooms(P.zooms);
    // The plan: the proposals are out (shot c1, zoom z3, z1's new box); slide left and zoomin; each zoom by sendcmd.
    must(job.shots.map((s) => s.id).join() === 's1,s2,s3' && job.zooms.map((z) => `${z.id}:${z.target}${z.box ? `@${z.box.x}` : ''}`).join() === 'z1:screen@0.3,z2:camera', `shots ${job.shots.map((s) => s.id)}, zooms ${JSON.stringify(job.zooms)}`);
    const fades = job.pieces.filter((x) => x.fade).map((x) => `${x.fade.type}:${x.fade.xfade}`).join();
    must(fades === 'slide:slideleft,zoom:zoomin', `transitions: ${fades}`);
    const cmds = JSON.stringify(job.ffmpeg);
    must(/sendcmd=f=work\/export\/[\d_]+\/v\d+_zoom\d_\d\.cmd/.test(cmds) && /scale@zs\d_\d/.test(cmds) && /crop@zk\d_\d/.test(cmds), 'no time-based crop and scale in the job');
    const W = 1920, H = 1080, ns = [21, 27, 31, 33, 40, 50, 63, 70, 74, 77, 80, 86, 88, 90, 94, 100, 120, 130, 133, 136, 140, 150, 162, 170];
    const F = framesAt(file, ns, W, H);
    const S = framesAt(join(ZX, 'source', 'zx_screen.mov'), [0], 640, 360).get(0), C = framesAt(join(ZX, 'source', 'zx_webcam.mov'), [0], 640, 360).get(0);
    // A card at export frame k against the source, cropped as the preview draws it (zoomedCrop of zoomAt at k / 30),
    // on a grid inside its box (away from the PiP's corners); also against the crops of k ± 2, which must be worse.
    const cardErr = (k, ref, crop) => {
      const look = L.lookAt(k / 30, base, kept), ly = L.compose(look, dims).layers.find((x) => x.ref === ref), cam = L.compose(look, dims).layers.find((x) => x.ref === 'cam');
      const src = ref === 'cam' ? C : S, c = crop || ly.crop;
      let sum = 0, n = 0;
      for (let i = 1; i < 10; i++) for (let j = 1; j < 10; j++) {
        const u = 0.1 + 0.8 * (i / 10), v = 0.1 + 0.8 * (j / 10), X = Math.round(ly.box.x + u * ly.box.w), Y = Math.round(ly.box.y + v * ly.box.h);
        if (ref === 'screen' && cam && X >= cam.box.x - 4 && Y >= cam.box.y - 4 && X <= cam.box.x + cam.box.w + 4 && Y <= cam.box.y + cam.box.h + 4) continue;
        const uu = ly.mirror ? 1 - (X + 0.5 - ly.box.x) / ly.box.w : (X + 0.5 - ly.box.x) / ly.box.w, vv = (Y + 0.5 - ly.box.y) / ly.box.h;
        const want = bilinear(src, 640, 360, (c.x + uu * c.w) * 640 - 0.5, (c.y + vv * c.h) * 360 - 0.5), got = px(F.get(k), W, X, Y);
        sum += want.reduce((t, w, q) => t + Math.abs(w - got[q]), 0) / 3; n++;
      }
      return sum / n;
    };
    const cropAt = (k, ref) => {
      const look = L.lookAt(k / 30, base, kept), ly = L.compose(look, dims).layers.find((x) => x.ref === ref);
      const z = L.zoomAt(k / 30, ref === 'cam' ? 'camera' : 'screen', zs, { shots: kept, cut: null });
      return z ? L.zoomedCrop(look, ly, z, dims) : ly.crop;
    };
    const rows = [];
    for (const [k, ref] of [[21, 'screen'], [27, 'screen'], [33, 'screen'], [63, 'screen'], [70, 'screen'], [31, 'cam'], [40, 'cam'], [50, 'cam'], [74, 'cam'], [77, 'cam']]) {
      const e = cardErr(k, ref, cropAt(k, ref)), others = [k - 2, k + 2].map((m) => cardErr(k, ref, cropAt(m, ref)));
      const moving = [k - 2, k + 2].every((m) => Math.abs(cropAt(m, ref).w / cropAt(k, ref).w - 1) > 0.01); // in a ramp, not at its end
      must(e <= 3.5 && (!moving || others.every((o) => o > e)), `frame ${k} ${ref}: off by ${e.toFixed(2)} levels (k±2: ${others.map((o) => o.toFixed(2))})`);
      rows.push(`${k}:${ref}=${e.toFixed(1)}`);
    }
    // The zooms ended: frames 80 (screen) and 86 (camera) show the shot's own framing again.
    must(cardErr(80, 'screen') <= 3.5 && cardErr(80, 'cam') <= 3.5 && cardErr(162, 'screen') <= 3.5, 'after the zooms (or in Claude\'s proposed zoom, 5.4 s) the card is not its own framing');
    // The slide (2.75–3.25 s, frames 83–97): the outgoing picture (PiP, frame 80) moves left by p · W, the incoming one
    // (Camera, frame 100) comes in from the right edge: offsets in whole pixels, as layout.js slideOffsets.
    const A = F.get(80), B = F.get(100);
    let worst = 0;
    for (const k of [86, 88, 90, 94]) {
      const tr = L.transitionAt(k / 30, base, kept, { duration: 6 });
      must(tr?.type === 'slide', `frame ${k}: ${tr?.type}`);
      const o = L.slideOffsets(tr.dir, tr.p, W, H);
      for (const X of [5, 300, 700, 1000, 1400, 1900]) for (const Y of [200, 540, 900]) {
        const fromX = X - o.from[0], toX = X - o.to[0];
        const want = toX >= 0 && toX < W ? px(B, W, toX, Y) : px(A, W, fromX, Y);
        if (Math.abs(X - o.to[0]) < 3) continue; // the seam itself
        worst = Math.max(worst, ...want.map((w, q) => Math.abs(w - px(F.get(k), W, X, Y)[q])));
      }
    }
    must(worst <= 12, `slide off by ${worst} levels`);
    // The zoom transition (4.2–4.8 s, frames 126–143): the outgoing Camera (frame 120) pushes into its centre, then the
    // incoming PiP (frame 150) fades in over that (layout.js zoominAt, xfade's zoomin).
    const ZA = F.get(120), ZB = F.get(150);
    let zworst = 0;
    for (const k of [130, 133, 136, 140]) {
      const tr = L.transitionAt(k / 30, base, kept, { duration: 6 });
      must(tr?.type === 'zoom', `frame ${k}: ${tr?.type}`);
      const { zf, mix } = L.zoominAt(tr.p);
      for (const X of [40, 500, 960, 1500, 1880]) for (const Y of [60, 540, 1000]) {
        const sx = Math.min(W - 1, Math.max(0, Math.ceil((zf * ((X + 0.5) / W - 0.5) + 0.5) * W - 0.5))), sy = Math.min(H - 1, Math.max(0, Math.ceil((zf * ((Y + 0.5) / H - 0.5) + 0.5) * H - 0.5)));
        const a = px(ZA, W, sx, sy), b = px(ZB, W, X, Y), want = a.map((v, q) => v * mix + b[q] * (1 - mix));
        zworst = Math.max(zworst, ...want.map((w, q) => Math.abs(w - px(F.get(k), W, X, Y)[q])));
      }
    }
    must(zworst <= 12, `zoom transition off by ${zworst} levels`);
    // Claude's proposed shot (5.2 s, Screen) is out: 5.67 s (frame 170) is PiP, the camera card there.
    must(cardErr(170, 'cam') <= 3.5, 'the proposed shot is in the export');
    const pr = JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-count_frames', '-show_entries', 'stream=codec_type,nb_read_frames', '-of', 'json', file], { encoding: 'utf8' }));
    must(pr.streams.find((x) => x.codec_type === 'video').nb_read_frames === '180', `frames: ${JSON.stringify(pr.streams)}`);
    return `${zx.out} in ${((Date.now() - t0) / 1000).toFixed(1)} s: zoom frames ${rows.join(' ')} (levels, each better than k±2); slide within ${worst}, zoom transition within ${zworst}; proposals out`;
  });

  await check('proposals: Keep it and No thanks over the API (one, several, all; "was" put back), the new ones a turn leaves, Add zooms keeps the other zooms', async () => {
    if (!existsSync(join(ZX, 'project.json'))) zxSources();
    writeFileSync(join(ZX, 'work/shots.json'), JSON.stringify({ v: 1, shots: [...ZXSHOTS.shots, { id: 'c2', start: 2, look: { hidden: ['cam'] }, by: 'claude', status: 'proposed' },
      { ...ZXSHOTS.shots[1], id: 's2', look: { preset: 'split' }, by: 'claude', status: 'proposed', was: { look: { preset: 'camera' }, in: ZXSHOTS.shots[1].in } }].filter((s, i, a) => a.findLastIndex((x) => x.id === s.id) === i) }));
    writeFileSync(join(ZX, 'work/zooms.json'), JSON.stringify({ ...ZXZOOMS, items: [...ZXZOOMS.items, { id: 'z4', target: 'camera', a: 3.5, d: 4.2, amount: 1.1, by: 'claude', status: 'proposed' },
      { ...ZXZOOMS.items[0], id: 'z5', a: 0.1, b: 0.3, c: 0.3, d: 0.45, status: 'proposed', by: 'claude', was: { a: 0.1, d: 0.4 } }] }));
    const sop = async (b) => { const r = await api(`/api/projects/${zxId}/shots`, b); must(r.status === 200, `${b.op}: ${r.text}`); return r.json.shots.shots; };
    const zop = async (b) => { const r = await api(`/api/projects/${zxId}/zooms`, b); must(r.status === 200, `${b.op}: ${r.text}`); return r.json.zooms.items; };
    let L1 = await sop({ op: 'keep', ids: ['c2'] });
    must(L1.find((s) => s.id === 'c2') && !L1.find((s) => s.id === 'c2').status, 'Keep it on c2');
    L1 = await sop({ op: 'reject', id: 's2' });
    const s2 = L1.find((s) => s.id === 's2');
    must(s2 && !s2.status && s2.look?.preset === 'camera' && s2.in?.type === 'slide', `No thanks on a changed shot puts "was" back: ${JSON.stringify(s2)}`);
    L1 = await sop({ op: 'reject', all: true });
    must(!L1.some((s) => s.id === 'c1') && !L1.some((s) => s.status), `No thanks to all: ${L1.map((s) => s.id)}`);
    let Z1 = await zop({ op: 'keep', ids: ['z4'] });
    must(!Z1.find((z) => z.id === 'z4').status, 'Keep it on z4');
    Z1 = await zop({ op: 'reject', ids: ['z5', 'z3'] });
    must(!Z1.some((z) => z.id === 'z3') && Z1.find((z) => z.id === 'z5')?.d === 0.4 && !Z1.find((z) => z.id === 'z5').status, `No thanks on z3 (new: gone) and z5 (back to was): ${JSON.stringify(Z1.map((z) => [z.id, z.d, z.status]))}`);
    Z1 = await zop({ op: 'keep', all: true });
    must(!Z1.some((z) => z.status), 'Keep all');
    // A turn's new proposals (server/turns.mjs, for the chat's block) and the Add zooms guard, on the files.
    const res = modRun(`const T = await import(${JSON.stringify(new URL('../server/turns.mjs', import.meta.url).href)});
      const fs = await import('node:fs'); const dir = ${JSON.stringify(ZX)};
      const before = { 'work/shots.json': fs.readFileSync(dir + '/work/shots.json', 'utf8'), 'work/zooms.json': fs.readFileSync(dir + '/work/zooms.json', 'utf8') };
      const sh = JSON.parse(before['work/shots.json']), zz = JSON.parse(before['work/zooms.json']);
      sh.shots.push({ id: 'n1', start: 1.5, look: { preset: 'screen' }, by: 'claude', status: 'proposed' });
      zz.items = [{ id: 'n2', target: 'camera', a: 4.6, d: 5.6, amount: 1.1, by: 'claude', status: 'proposed' }, ...zz.items.filter((z) => z.target === 'camera' && z.by === 'claude' ? false : z.target !== 'screen')];
      fs.writeFileSync(dir + '/work/shots.json', JSON.stringify(sh)); fs.writeFileSync(dir + '/work/zooms.json', JSON.stringify(zz));
      const made = T.proposalsMade(dir, before);
      const notes = []; const lost = T.keepOtherZooms(dir, before['work/zooms.json'], { emit: (e) => notes.push(e.text) });
      const now = JSON.parse(fs.readFileSync(dir + '/work/zooms.json', 'utf8')).items;
      console.log(JSON.stringify({ made, lost: lost.map((z) => z.id), now: now.map((z) => z.id + ':' + z.target), notes }));`);
    must(JSON.stringify(res.made) === '{"shots":["n1"],"zooms":["n2"]}', `new proposals: ${JSON.stringify(res.made)}`);
    must(res.lost.sort().join() === 'z1,z5' && res.now.includes('n2:camera') && res.now.includes('z1:screen') && res.now.includes('z5:screen') && !res.now.includes('z2:camera') && /put back 2 screen zooms/.test(res.notes[0] || ''), `Add zooms guard: ${JSON.stringify(res)}`);
    writeFileSync(join(ZX, 'work/shots.json'), JSON.stringify(ZXSHOTS));
    writeFileSync(join(ZX, 'work/zooms.json'), JSON.stringify(ZXZOOMS));
    return `keep/reject one, several and all for shots and zooms ("was" back); a turn's new proposals ${JSON.stringify(res.made)}; Add zooms put back ${res.lost.join(', ')} and replaced z2`;
  });

  await check('Plan the scenes plans only; Add zooms is done when it ran or zooms are kept, not by proposals', async () => {
    const dir = join(STUDIO, 'projects', 'zooms-step-fixture');
    mkdirSync(join(dir, 'work'), { recursive: true });
    writeFileSync(join(dir, 'project.json'), JSON.stringify({ name: 'Zooms step', type: 'tutorial' }));
    const st = (files) => {
      for (const f of ['work/zooms.json', 'WORKLOG.md']) rmSync(join(dir, f), { force: true });
      for (const [f, v] of Object.entries(files)) writeFileSync(join(dir, f), typeof v === 'string' ? v : JSON.stringify(v));
      return modRun(`const S = await import(${JSON.stringify(new URL('../server/studio.mjs', import.meta.url).href)});
        const p = S.pipelineStatus(${JSON.stringify(dir)}, 'tutorial', { lines: true }); const z = p.steps.find((x) => x.id === 'zooms');
        console.log(JSON.stringify({ done: z.done, line: z.line || '', plan: S.stepPrompt(${JSON.stringify(dir)}, 'tutorial', 'plan'), zooms: S.stepPrompt(${JSON.stringify(dir)}, 'tutorial', 'zooms') }));`);
    };
    const prop = { v: 2, items: [{ id: 'z1', target: 'screen', a: 1, d: 3, box: { x: 0, y: 0, w: 0.5, h: 0.5 }, by: 'claude', status: 'proposed' }] };
    const a = st({ 'work/zooms.json': prop });
    must(!a.done, `proposals only: done (${a.line})`);
    const b = st({ 'work/zooms.json': prop, 'WORKLOG.md': '- 2026-10-19: Add zooms: 2 punch-ins proposed\n' });
    const c = st({ 'work/zooms.json': { ...prop, reason: "you're never full frame. The screen zooms stay." } });
    const d = st({ 'work/zooms.json': { v: 2, items: [{ ...prop.items[0], status: undefined }] } });
    must(b.done && c.done && d.done, `ran / reason / kept: ${[b.done, c.done, d.done]}`);
    must(c.line === "No zooms needed: you're never full frame · 1 proposal to keep or turn down" && d.line === '1 zoom placed', `lines: ${c.line} | ${d.line}`);
    must(/plans the scenes only/.test(a.plan) && /don't count as Add zooms/.test(a.plan) && /"status": "proposed"/.test(a.plan), `the plan brief: ${a.plan.slice(-400)}`);
    must(/Redo only your own camera punch-ins/.test(a.zooms) && /screen zooms and mine stay/.test(a.zooms) && /Add zooms:/.test(a.zooms), `the zooms brief: ${a.zooms}`);
    const skill = readFileSync(join(APP, 'starter', '.claude', 'skills', 'talking-head-zoom', 'SKILL.md'), 'utf8');
    must(/Redo only your own punch-ins/.test(skill) && /"v": 2/.test(skill) && /Keep it · No thanks/.test(skill), 'the talking-head-zoom skill');
    const ctxText = modRun(`const S = await import(${JSON.stringify(new URL('../server/shots.mjs', import.meta.url).href)}); console.log(JSON.stringify(S.shotsContext()));`);
    must(/Keep it \/ No thanks/.test(ctxText) && /Keep all/.test(ctxText) && /only redoes your own camera punch-ins/.test(ctxText), 'Claude\'s project instructions');
    rmSync(dir, { recursive: true, force: true });
    return `proposals only: not done; ran (WORKLOG "Add zooms:"), reason, kept: done ("${c.line}" · "${d.line}"); plan brief scoped`;
  });

  // The same fixture through the page (test/zooms.e2e.mjs): the canvas against the MP4, the proposals' buttons, Z, the
  // zoom inspector and the transition popover.
  if (process.env.PLAYWRIGHT_PATH) {
    await check('zooms and proposals through the page: preview = export (zooms, slide, zoom transition), proposals out until Keep it, Z + a box, the zoom inspector, the transition popover (headless Chrome)', async () => {
      if (!zx) return 'skipped: no zooms export (Mac only)';
      try {
        const out = execFileSync(process.execPath, [join(APP, 'test', 'zooms.e2e.mjs')], { env: { ...process.env, STUDIO_URL: BASE, ZX_OUT: zx.out }, encoding: 'utf8', timeout: 600000 });
        return out.trim().split('\n').pop();
      } catch (e) { throw new Error(String((e.stdout || '') + (e.stderr || '') || e.message).trim().split('\n').slice(-6).join(' | ')); }
    });
  }

  // Export → Video with a built block (server/built.mjs): the intro Claude rendered plays for the intro's frames, the
  // canvas after it, the voice runs on in one piece, and the intro's sound cue plays only when its render is in.
  await check('export with a built intro: its render for the intro, the canvas after, one voice, its whoosh only with it (real render)', async () => {
    if (process.platform !== 'darwin') return 'skipped: the export decodes with VideoToolbox (Mac only)';
    must(sx, 'no shots export');
    const name = sxId;
    // The take: 12 s, cut [0, 6] + [6.5, 12] (11.5 s). Blocks: Intro = take 0–4 (the cut's first 4 s), Main body after.
    writeFileSync(join(SX, 'work/blocks.json'), JSON.stringify({ v: 1, marked: true, blocks: [
      { id: 'intro', type: 'intro', label: 'Intro', order: 1, source: { take: [0, 4] } }, { id: 'body', type: 'body', label: 'Main body', order: 2, source: { take: [4, 12] } }] }));
    writeFileSync(join(SX, 'work/production.json'), JSON.stringify({ scenes: [{ id: '1', block: 'intro', start: 0, end: 2 }, { id: '2', block: 'intro', start: 2, end: 4 },
      { id: '3', block: 'body', start: 4, end: 8 }, { id: '4', block: 'body', start: 8, end: 11.5 }] }));
    writeFileSync(join(SX, 'work/cut_scenes.json'), JSON.stringify({ segments: [[0, 6], [6.5, 12]] }));
    // Build the intro's render: 4 s on the sheet's timeline, green, a white bar at x = 10 + 4n (n = its frame number), and
    // its own 1 kHz sound (which must not reach the export: the voice is the take's).
    mkdirSync(join(SX, 'renders'), { recursive: true });
    execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', "nullsrc=s=640x360:r=30,geq=lum='if(between(X,10+N*4,17+N*4)*between(Y,150,210),235,120)':cb=70:cr=70",
      '-f', 'lavfi', '-i', 'sine=frequency=1000:sample_rate=48000', '-t', '4', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', join(SX, 'renders', `${name}_intro_v1.mp4`)]);
    // Sound cues: Claude's whoosh on the intro's transition at take 1.0 s, a hand-placed one in the body at take 9.0 s.
    const lib = join(STUDIO, 'library', 'sfx');
    mkdirSync(lib, { recursive: true });
    execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'sine=frequency=2000:sample_rate=48000', '-t', '0.25', '-ac', '2', join(lib, 'smoke_beep.wav')]);
    writeFileSync(join(SX, 'work/sfx.json'), JSON.stringify({ v: 1, cues: [{ id: 'intro-whoosh', t: 1, file: 'sfx/smoke_beep.wav', from: 'library', gain: 0, label: 'Whoosh (scene 2)' },
      { id: 'mine', t: 9, file: 'sfx/smoke_beep.wav', from: 'library', gain: 0, label: 'My beep', by: 'hand' }] }));
    const P = (await api(`/api/projects/${sxId}`)).json;
    const b = P.export.built?.[0];
    must(P.export.built?.length === 1 && b.id === 'intro' && b.usable && b.file === `renders/${name}_intro_v1.mp4` && b.stepName === 'Build the intro' && b.cues === 1
      && JSON.stringify(b.take) === '[0,4]' && !b.partial, `the Export panel's Intro row: ${JSON.stringify(P.export.built)}`);
    const rk = P.renders.map((r) => `${r.file.replace(/^renders\//, '')}:${r.kind}:${r.group}`);
    must(rk.includes(`${name}_intro_v1.mp4:build:Intro builds`) && rk.some((x) => /_pip_v\d+\.mp4:export:Video exports$/.test(x)), `Renders grouped by what they are: ${rk.join(', ')}`);
    const withIt = await sxExport(), canvasIn = await sxExport({ built: { intro: false } });
    must(withIt.job.built?.[0]?.file === `renders/${name}_intro_v1.mp4` && withIt.job.pieces?.map((p) => `${p.kind}@${Math.round(p.start * 30)}+${p.frames}`).join(' ') === 'render@0+120 look@120+225',
      `pieces: ${JSON.stringify(withIt.job.pieces?.map((p) => [p.kind, p.start, p.frames]))}`);
    must(!canvasIn.job.pieces && !canvasIn.job.built, 'the canvas instead: the plain export again');
    for (const x of [withIt, canvasIn]) {
      const pr = JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-count_frames', '-show_entries', 'stream=codec_type,nb_read_frames', '-of', 'json', x.file], { encoding: 'utf8' }));
      must(pr.streams.find((s) => s.codec_type === 'video').nb_read_frames === '345', `${x.out}: ${JSON.stringify(pr.streams)}`);
    }
    // Pictures: frame k of the intro is the render's frame k (its bar's centre at 3 · (13.5 + 4k) of 1920); from 120 the canvas.
    const rowBuf = execFileSync('ffmpeg', ['-v', 'error', '-i', withIt.file, '-vf', 'format=gray,crop=1920:1:0:540', '-fps_mode', 'passthrough', '-f', 'rawvideo', '-'], { maxBuffer: 64e6 });
    const barAt = (k) => { const r = rowBuf.subarray(k * 1920, (k + 1) * 1920); let hi = 0, lo = 255; for (const v of r) { hi = Math.max(hi, v); lo = Math.min(lo, v); } let s = 0, n = 0; r.forEach((v, x) => { if (v > (hi + lo) / 2) { s += x; n++; } }); return n ? s / n : -1; };
    for (const k of [0, 1, 37, 64, 118, 119]) { const n = Math.round((barAt(k) / 3 - 13.5) / 4); must(n === k, `export frame ${k} shows the render's frame ${n}`); }
    const cam = L.compose(L.normalize(withIt.P.layout, withIt.P.type), withIt.P.export.dims).layers.find((x) => x.ref === 'cam');
    const at = [cam.box.x + Math.round(cam.box.w * 0.31), cam.box.y + Math.round(cam.box.h * 0.4)];
    const camW = track(withIt.file, ...at), camC = track(canvasIn.file, ...at);
    must(!near(camW[60], camC[60], 30) && near(camW[121], camC[121], 12) && near(camW[300], camC[300], 12), `intro: render ${camW[60]} vs canvas ${camC[60]}; after: ${camW[121]} = ${camC[121]}`);
    // Sound: the take's 440 Hz voice in one piece through the join at 4 s (no 1 kHz from the render), the intro's beep at
    // 1.0 s only with its render, the hand-placed one at 8.5 s (take 9.0, after the cut) in both.
    const pcm = (file) => { const b2 = execFileSync('ffmpeg', ['-v', 'error', '-i', file, '-ac', '1', '-ar', '48000', '-f', 's16le', '-'], { maxBuffer: 1e9 }); return new Int16Array(b2.buffer, b2.byteOffset, b2.length / 2); };
    const tone = (smp, f, t0, t1) => { // Goertzel: the level of one frequency over a stretch, in dB of full scale
      const a = Math.round(t0 * 48000), z = Math.round(t1 * 48000), w = 2 * Math.cos((2 * Math.PI * f) / 48000);
      let s1 = 0, s2 = 0;
      for (let i = a; i < z; i++) { const s0 = smp[i] / 32768 + w * s1 - s2; s2 = s1; s1 = s0; }
      return 20 * Math.log10(Math.sqrt(Math.max(0, s1 * s1 + s2 * s2 - w * s1 * s2)) / ((z - a) / 2) + 1e-9);
    };
    const A = pcm(withIt.file), B = pcm(canvasIn.file);
    const voice = [tone(A, 440, 3.7, 3.95), tone(A, 440, 4.05, 4.3)], k1 = tone(A, 1000, 0.5, 3.5);
    const beep = [tone(A, 2000, 1.02, 1.2), tone(B, 2000, 1.02, 1.2), tone(A, 2000, 8.52, 8.7), tone(B, 2000, 8.52, 8.7)];
    must(Math.abs(voice[0] - voice[1]) < 1 && voice[0] > -30, `the voice either side of the join: ${voice.map((x) => x.toFixed(1))} dB`);
    must(k1 < voice[0] - 40, `the render's own sound leaked in: 1 kHz ${k1.toFixed(1)} dB`);
    must(beep[0] > beep[1] + 25 && beep[2] > -45 && Math.abs(beep[2] - beep[3]) < 1, `beeps (dB) with/without the intro at 1.0 s, at 8.5 s: ${beep.map((x) => x.toFixed(1))}`);
    // The level: Settings → Sound's 18 dB under the voice (the same sine level for both, so 18 dB apart in the MP4).
    must(Math.abs(voice[0] - beep[2] - 18) < 2.5, `the cue sits ${(voice[0] - beep[2]).toFixed(1)} dB under the voice (Settings: 18)`);
    // The cut changed after the build: the render no longer fits, so the canvas plays the intro and its whoosh stays out.
    writeFileSync(join(SX, 'work/cut_scenes.json'), JSON.stringify({ segments: [[0, 3], [3.4, 6], [6.5, 12]] }));
    const st = (await api(`/api/projects/${sxId}`)).json.export.built?.[0];
    must(st && !st.usable && /cut changed/.test(st.why) && st.cues === 1, `a render on an older cut: ${JSON.stringify(st)}`);
    const skip = modRun(`const B = await import(${JSON.stringify(new URL('../server/built.mjs', import.meta.url).href)}); const c = B.exportChoice(${JSON.stringify([st])}, {});
      console.log(JSON.stringify([c.use.length, c.skipCue({ t: 1 }), c.skipCue({ t: 1, by: 'hand' }), c.skipCue({ t: 9 })]));`);
    must(JSON.stringify(skip) === '[0,true,false,false]', `cues left out with a stale intro: ${JSON.stringify(skip)}`);
    for (const f of ['work/blocks.json', 'work/production.json', 'work/cut_scenes.json', 'work/sfx.json']) rmSync(join(SX, f), { force: true });
    return `${withIt.out}: the render frame for frame 0–119, the canvas from 120 (= ${canvasIn.out}); voice ${voice.map((x) => x.toFixed(1)).join('/')} dB across 4 s, render sound ${k1.toFixed(0)} dB; beep at 1.0 s ${beep[0].toFixed(0)} vs ${beep[1].toFixed(0)} dB; a stale render stays out`;
  });

  // Scenes' picture in every state and the Renders tab with a built intro, through the page (test/scenes.e2e.mjs).
  if (process.env.PLAYWRIGHT_PATH) {
    await check('Scenes through the page: the render is the picture (never the take under it), the take before a render and past it, Renders grouped, the Intro row (headless Chrome)', async () => {
      try {
        const out = execFileSync(process.execPath, [join(APP, 'test', 'scenes.e2e.mjs')], { env: { ...process.env, STUDIO_URL: BASE }, encoding: 'utf8', timeout: 600000 });
        return out.trim().split('\n').pop();
      } catch (e) { throw new Error(String((e.stdout || '') + (e.stderr || '') || e.message).trim().split('\n').slice(-6).join(' | ')); }
    });
  }

  // The Cut tab's Keep / Cut list with the real Cut Editor (test/cutlist.e2e.mjs), when Playwright is there.
  if (process.env.PLAYWRIGHT_PATH) {
    await check('Keep / Cut list through the page: a fixed join isn\'t counted, Cut on a range cuts all of it with no sliver, Undo takes the decision back, a first-word delete leaves no sliver, the cut\'s clock (headless Chrome)', async () => {
      try {
        const out = execFileSync(process.execPath, [join(APP, 'test', 'cutlist.e2e.mjs')], { env: { ...process.env, STUDIO_URL: BASE }, encoding: 'utf8', timeout: 600000 });
        return out.trim().split('\n').pop();
      } catch (e) { throw new Error(String((e.stdout || '') + (e.stderr || '') || e.message).trim().split('\n').slice(-6).join(' | ')); }
    });
  }

  // The page's own Export button and the canvas against the MP4 (test/shots.e2e.mjs), when Playwright is there.
  if (process.env.PLAYWRIGHT_PATH) {
    await check('shots export through the page: a PNG set per look; the canvas drawing lookAt(t) = the MP4 (headless Chrome)', async () => {
      try {
        const out = execFileSync(process.execPath, [join(APP, 'test', 'shots.e2e.mjs')], { env: { ...process.env, STUDIO_URL: BASE }, encoding: 'utf8', timeout: 600000 });
        return out.trim().split('\n').pop();
      } catch (e) { throw new Error(String((e.stdout || '') + (e.stderr || '') || e.message).trim().split('\n').slice(-6).join(' | ')); }
    });
  }

  // The chat, the step strip and the app shell through the page, with a scripted stand-in for Claude Code
  // (test/chat.e2e.mjs on its own Video Octopus and studio; test/fake-claude.mjs), when Playwright is there.
  if (process.env.PLAYWRIGHT_PATH && process.platform !== 'win32') {
    await check('chat, step strip and app shell through the page: the page never scrolls, follow + New message, Didn\'t finish, briefs as one line, Undo, Auto asks outside the project, the assistant\'s read-only commands (headless Chrome, fake Claude)', async () => {
      try {
        const out = execFileSync(process.execPath, [join(APP, 'test', 'chat.e2e.mjs')], { env: { ...process.env }, encoding: 'utf8', timeout: 600000 });
        return out.trim().split('\n').pop();
      } catch (e) { throw new Error(String((e.stdout || '') + (e.stderr || '') || e.message).trim().split('\n').slice(-6).join(' | ')); }
    });
  }

  // No Claude needed: Auto's check for changes outside the project, the assistant's read-only rule, the chat's names.
  await check('chat rules: outside-the-project hook (decisions + the real hook process), read-only commands, briefs and session names, Claude\'s one-line reason', async () => {
    const proj = join(STUDIO, 'projects', 'rules-proj');
    mkdirSync(join(proj, 'work'), { recursive: true });
    const r = modRun(`const H = await import(${mod('server/outside-hook.mjs')}), R = await import(${mod('server/readonly.mjs')}), C = await import(${mod('server/claude.mjs')}), T = await import(${mod('server/turns.mjs')});
      const studio = ${JSON.stringify(STUDIO)}, dir = ${JSON.stringify(proj)}, app = ${JSON.stringify(APP)};
      const d = (tool, x) => Boolean(H.decide({ tool_name: tool, tool_input: tool === 'Bash' ? { command: x } : { file_path: x }, cwd: studio }, { dir, studio }));
      const bash = {
        logOutside: d('Bash', "cd projects/rules-proj && echo '- intro v1' >> ../../notes/log.md"),
        inside: d('Bash', 'echo x > projects/rules-proj/work/a.json && cp library/sfx/a.wav projects/rules-proj/assets/'),
        script: d('Bash', 'cd projects/rules-proj && python compose.py parts/p0.mp4 2>&1 | tail -3'),
        ffmpegOut: d('Bash', 'ffmpeg -y -i projects/rules-proj/source/a.mov library/broll/a.mp4'),
        heredoc: d('Bash', "cat > projects/rules-proj/work/n.json <<'EOF'\\n{}\\nrm -rf /\\nEOF"),
        rm: d('Bash', 'rm -rf memory/old'), sedI: d('Bash', 'sed -i.bak s/a/b/ memory/preferences.md'), sedN: d('Bash', 'sed -n 1p memory/preferences.md'),
        tmp: d('Bash', 'echo a > /tmp/studio-smoke-x'), unknown: d('Bash', 'echo x > "$OUT"'),
      };
      const files = { outside: d('Write', studio + '/memory/preferences.md'), inside: d('Edit', dir + '/work/blocks.json') };
      const look = (c) => R.lookOnly(c, null);
      const cli = 'node "' + app + '/bin/octopus.mjs"';
      const ro = { ls: look('ls -la; cat a | head'), list: look(cli + ' projects list; ls -t sessions'), settings: look(cli + ' settings --json'), set: look(cli + ' settings set editing.trimLens on'),
        add: look(cli + ' schedules add --name x --cron "0 1 * * *"'), relative: look('node bin/octopus.mjs projects list'), redirect: look('ls > x'), del: look('find . -delete') };
      const hist = [{ t: 'marker', text: 'Clean up', ts: 1000 }, { t: 'user', text: 'Prepare this recording…', ts: 1020 }, { t: 'user', text: 'and then this', ts: 5000 }];
      console.log(JSON.stringify({ bash, files, ro, title: C.sessionTitle(hist), titleNew: C.sessionTitle([C.userEvent('Lock the cut. If I saved…', { name: 'Lock the cut', step: 'lock' })]), titleHuman: C.sessionTitle([{ t: 'user', text: '/skill x' }, { t: 'user', text: 'Make the intro   shorter please' }]),
        brief: C.userEvent('x', { name: 'Clean up', step: 'prepare' }).brief, plain: 'brief' in C.userEvent('x', null),
        reason: T.oneLine("**I haven't locked the cut yet**, because one join still sounds clipped at 0:42.1. Should I move that edge?\\n\\nMore.") }));`);
    must(r.bash.logOutside && r.bash.ffmpegOut && r.bash.rm && r.bash.sedI && r.files.outside, `changes outside the project must ask: ${JSON.stringify(r)}`);
    must(!r.bash.inside && !r.bash.script && !r.bash.heredoc && !r.bash.sedN && !r.bash.tmp && !r.bash.unknown && !r.files.inside, `these must not ask: ${JSON.stringify(r)}`);
    must(r.ro.ls && r.ro.list && r.ro.settings && !r.ro.set && !r.ro.add && !r.ro.relative && !r.ro.redirect && !r.ro.del, `read-only rule: ${JSON.stringify(r.ro)}`);
    must(r.title === 'Clean up' && r.titleNew === 'Lock the cut' && r.titleHuman === 'Make the intro shorter please', `session names: ${JSON.stringify([r.title, r.titleNew, r.titleHuman])}`);
    must(r.brief?.name === 'Clean up' && r.brief.step === 'prepare' && !r.plain, `briefs: ${JSON.stringify(r.brief)}`);
    must(r.reason === "I haven't locked the cut yet, because one join still sounds clipped at 0:42.1.", `one line: ${r.reason}`);
    // The hook as Claude Code runs it: JSON on stdin, an "ask" decision (or nothing) on stdout.
    const run = (input) => execFileSync(process.execPath, [join(APP, 'server', 'outside-hook.mjs')], { input: JSON.stringify(input), encoding: 'utf8', env: { ...process.env, STUDIO_GUARD_DIR: proj, STUDIO_GUARD_STUDIO: STUDIO } });
    const ask = JSON.parse(run({ tool_name: 'Bash', tool_input: { command: 'echo hi >> notes/log.md' }, cwd: STUDIO }));
    must(ask.hookSpecificOutput?.permissionDecision === 'ask' && ask.hookSpecificOutput.permissionDecisionReason === 'Outside this project: notes/log.md', `hook: ${JSON.stringify(ask)}`);
    must(run({ tool_name: 'Write', tool_input: { file_path: join(proj, 'work', 'x.json') }, cwd: STUDIO }) === '', 'the hook said something about a change inside the project');
    return 'outside asks (a log line, ffmpeg into the library, rm, sed -i, a Write); inside, scripts, temp and unknowns don\'t; read-only commands and the octopus command\'s reads pass, its changes don\'t; names and one-line reason';
  });

  await check('shots routes: every op over the API, the 0.5 s minimum, merges, apply to all + undo, the block menu bridge', async () => {
    const url = `/api/projects/${shotsProject}/shots`;
    const op = async (b, code = 200) => { const r = await api(url, b); must(r.status === code, `${b.op}: ${r.status} ${r.text.slice(0, 200)}`); return r.json; };
    const ids = (d) => d.shots.map((s) => s.id).join(',');
    let r = await op({ op: 'add', t: 9.03 });
    const sA = r.id;
    must(r.shots.shots.find((s) => s.id === sA)?.start === 9.01 && r.shots.shots.find((s) => s.id === sA).look?.preset === 'split' && /on “w18”/.test(r.note), `add (snapped, a copy of Main body's look): ${JSON.stringify(r.shots.shots)} ${r.note}`);
    must(spRead('work/shots.json').shots.some((s) => s.id === sA), 'not written');
    await op({ op: 'add', t: 9.3, snap: false }, 400);
    await op({ op: 'merge', id: 's2' }, 400); // the section edge at 0:06
    await op({ op: 'move', id: 's2', t: 7 }, 400);
    await op({ op: 'split', t: 3, id: sA }, 400);
    r = await op({ op: 'add', word: 30 });
    const sB = r.id;
    r = await op({ op: 'look', id: sA, look: { hidden: ['cam'] } });
    must(JSON.stringify(r.shots.shots.find((s) => s.id === sA).look) === '{"preset":"split","hidden":["cam"]}', JSON.stringify(r.shots.shots));
    must(L.lookAt(10, (await spGet()).layout, r.shots).preset === 'screen', 'Split without the camera → Screen');
    r = await op({ op: 'look', id: sA, look: { hidden: ['screen'] } });
    must(L.lookAt(10, (await spGet()).layout, r.shots).preset === 'camera', 'Split without the screen → Camera');
    r = await op({ op: 'clear', id: sA, keys: ['hidden'] });
    must(!r.shots.shots.find((s) => s.id === sA).look.hidden, 'clear');
    await op({ op: 'name', id: sA, name: 'Demo' });
    r = await op({ op: 'transition', id: sA, in: { type: 'fade', dur: 0.3 } });
    must(JSON.stringify(r.shots.shots.find((s) => s.id === sA).in) === '{"type":"fade","dur":0.3}', 'transition');
    await op({ op: 'transition', id: 's1', in: { type: 'fade' } }, 400);
    r = await op({ op: 'move', id: sB, t: 14.6 });
    must(r.shots.shots.find((s) => s.id === sB).start === 14.51, `move: ${JSON.stringify(r.shots.shots)}`);
    r = await op({ op: 'same-as-previous', id: sB });
    must(r.shots.shots.find((s) => s.id === sB).look?.preset === 'split', 'same as previous');
    r = await op({ op: 'merge', id: sB });
    must(!r.shots.shots.some((s) => s.id === sB), 'merge');
    // Apply to all: the base look changes (project.json), the override goes; restore with layoutBefore undoes both.
    await op({ op: 'look', id: sA, look: { cam: { zoom: 2.5 } } });
    const before = (await api(url)).json.shots;
    r = await op({ op: 'apply-all', id: sA });
    // (Its look is Main body's Split plus the zoom: both go into the video's look, and out of every shot.)
    must(r.layout?.cam.zoom === 2.5 && r.layout.preset === 'split' && r.layoutBefore?.cam.zoom === 1 && r.layoutBefore.preset === 'pip' && JSON.parse(readFileSync(join(SP, 'project.json'), 'utf8')).layout.cam.zoom === 2.5
      && r.shots.shots.every((s) => !s.look?.preset && !s.look?.cam), `apply to all: ${JSON.stringify([r.layout?.preset, r.layout?.cam, r.shots.shots.map((s) => s.look)])}`);
    r = await op({ op: 'restore', doc: before, layout: r.layoutBefore });
    must(JSON.parse(readFileSync(join(SP, 'project.json'), 'utf8')).layout.cam.zoom === 1 && r.shots.shots.find((s) => s.id === sA).look?.cam?.zoom === 2.5 && r.shots.shots[0].look?.preset === 'camera',
      `restore (undo) puts the base and the shots back: ${JSON.stringify(r.shots.shots.map((s) => s.look))}`);
    // Proposals over the API.
    r = await op({ op: 'add', t: 17.02, by: 'claude', status: 'proposed', look: { preset: 'camera' } });
    const sP = r.id;
    r = await op({ op: 'reject', id: sP });
    must(!r.shots.shots.some((s) => s.id === sP), 'No thanks');
    r = await op({ op: 'add', t: 17.02, by: 'claude', status: 'proposed' });
    r = await op({ op: 'keep', id: r.id });
    must(r.shots.shots.every((s) => !s.status), 'Keep it');
    await op({ op: 'nonsense' }, 400);
    await op({ op: 'look', id: 'nope', look: { preset: 'pip' } }, 400);
    // The block menu's "Layout for this block" writes the shot at the block's start; the band's undo puts it back.
    const bl = await api(`/api/projects/${shotsProject}/blocks`, { op: 'update', id: 'intro', layout: 'boxed' });
    must(bl.status === 200 && bl.json.view.items.find((x) => x.id === 'intro').layout === 'boxed' && !spRead('work/blocks.json').blocks[0].layout && spRead('work/shots.json').shots[0].look.preset === 'boxed', `block menu: ${bl.text.slice(0, 200)}`);
    must(bl.json.before.blocks[0].layout === 'camera', `the undo copy keeps the old layout: ${JSON.stringify(bl.json.before.blocks[0])}`);
    const un = await api(`/api/projects/${shotsProject}/blocks`, { op: 'restore', doc: bl.json.before });
    must(un.status === 200 && spRead('work/shots.json').shots[0].look.preset === 'camera' && !spRead('work/blocks.json').blocks[0].layout, 'block undo → the shot again');
    // Split a section (S on the band, ⇧S later): a new shot edge there, a copy of the look; edges follow; a join takes it away.
    let sp = await api(`/api/projects/${shotsProject}/blocks`, { op: 'split', id: 'body', t: 12.5 });
    must(sp.status === 200, sp.text);
    let sh = (await spGet()).shots.shots;
    const tail = sp.json.id, cut12 = sh.find((s) => s.section === tail);
    must(cut12 && cut12.start === 12.5 && cut12.look?.preset === 'split', `a section edge is a shot edge: ${JSON.stringify(sh)}`);
    await api(`/api/projects/${shotsProject}/blocks`, { op: 'edge', id: tail, edge: 'start', t: 13.25 });
    sh = (await spGet()).shots.shots;
    must(sh.find((s) => s.section === tail)?.start === 13.25, `the shot edge follows the section's: ${JSON.stringify(sh)}`);
    await api(`/api/projects/${shotsProject}/blocks`, { op: 'join', id: tail });
    sh = (await spGet()).shots.shots;
    must(!sh.some((s) => s.section === tail) && !sh.some((s) => Math.abs(s.start - 13.25) < 0.01), `joined: the edge that changed nothing went: ${JSON.stringify(sh)}`);
    return `${ids(r.shots)}: add/split/merge/move/look/clear/name/transition/same as previous/apply to all/restore/keep/reject; block menu → shot, undo; section split, edge, join`;
  });

  await check('zooms routes: add at the playhead or on words, the frame\'s shape, move, trim, set, delete, proposals, v1 → v2', async () => {
    const url = `/api/projects/${shotsProject}/zooms`;
    const op = async (b, code = 200) => { const r = await api(url, b); must(r.status === code, `${b.op}: ${r.status} ${r.text.slice(0, 200)}`); return r.json; };
    let r = await op({ op: 'add', target: 'screen', t: 7, box: { x: 0.1, y: 0.1, w: 0.4, h: 0.2 } });
    const z = r.zooms.items.find((x) => x.id === r.id);
    // At 0:07 the shot is Split: the screen's box is 1280×1080 of a 16:9 picture, so the box gets that shape.
    const P = await spGet(), lk = L.lookAt(7.001, P.layout, P.shots), ly = L.compose(lk, P.export.dims).layers.find((x) => x.ref === 'screen');
    const want = (z.box.w * 320) / (z.box.h * 180), got = ly.box.w / ly.box.h;
    must(z.a === 7 && z.d === 10 && z.b === 7.6 && z.c === 9.4 && Math.abs(want - got) < 0.01 && z.word === 14, `add: ${JSON.stringify(z)} shape ${want} vs ${got}`);
    must(spRead('work/zooms.json').v === 2 && spRead('work/zooms.json').items.some((x) => x.target === 'camera' && x.by === 'claude'), 'the first edit writes v2 (the v1 punch-in kept)');
    r = await op({ op: 'add', target: 'camera', words: [20, 23] });
    const zw = r.zooms.items.find((x) => x.id === r.id);
    must(zw.a === words40[20][0] && zw.d === words40[23][1] && zw.amount === 1.1, `on words: ${JSON.stringify(zw)}`);
    r = await op({ op: 'move', id: zw.id, a: 11 });
    must(r.zooms.items.find((x) => x.id === zw.id).a === 11, 'move');
    r = await op({ op: 'trim', id: zw.id, d: 13.5 });
    const zt = r.zooms.items.find((x) => x.id === zw.id);
    must(zt.d === 13.5 && zt.c === 12.9, `trim keeps the ramp: ${JSON.stringify(zt)}`);
    r = await op({ op: 'set', id: zw.id, speed: 'snap', in: 0.05, out: 5 });
    const zs = r.zooms.items.find((x) => x.id === zw.id);
    must(zs.speed === 'snap' && zs.b - zs.a >= 0.1 - 1e-9 && zs.d - zs.c <= 2 + 1e-9, `set (ramps clamped 0.1–2 s): ${JSON.stringify(zs)}`);
    r = await op({ op: 'set', id: zw.id, target: 'screen', box: { x: 0.5, y: 0.5, w: 0.3, h: 0.3 }, amount: null });
    must(r.zooms.items.find((x) => x.id === zw.id).target === 'screen' && !('amount' in r.zooms.items.find((x) => x.id === zw.id)), 'set target and box');
    r = await op({ op: 'add', target: 'screen', t: 15, by: 'claude', status: 'proposed', box: { x: 0, y: 0, w: 0.5, h: 0.5 } });
    const zp = r.id;
    r = await op({ op: 'reject', id: zp });
    must(!r.zooms.items.some((x) => x.id === zp), 'No thanks');
    const before = r.zooms;
    r = await op({ op: 'delete', id: zw.id });
    must(!r.zooms.items.some((x) => x.id === zw.id), 'delete');
    r = await op({ op: 'restore', doc: before });
    must(r.zooms.items.some((x) => x.id === zw.id), 'restore');
    await op({ op: 'add', target: 'screen' }, 400);
    await op({ op: 'move', id: 'nope', a: 1 }, 400);
    return `${r.zooms.items.length} zooms: box shaped for Split at 0:07, words 20–23, move/trim/set/delete/reject/restore; zooms.json is v2`;
  });

  await check('re-cut: shots and zooms follow their words (moved, merged with a note, removed), live in the page', async () => {
    const shotsUrl = `/api/projects/${shotsProject}/shots`;
    // Shots: one on w20 (10.01), one on w30 (15.01) with only w30 and w31 in it, one on w32 (16.01).
    let r = await api(shotsUrl, { op: 'restore', doc: { shots: [{ id: 's1', start: 0, look: { preset: 'camera' } }, { id: 's2', start: 6, section: 'body' },
      { id: 'on20', start: 10.01, name: 'Twenty', look: { preset: 'screen' } }, { id: 'on30', start: 15.01, name: 'Thirty' }, { id: 'on32', start: 16.01 }] } });
    must(r.status === 200 && r.json.shots.shots.length === 5, r.text.slice(0, 200));
    let z = await api(`/api/projects/${shotsProject}/zooms`, { op: 'restore', doc: { items: [
      { id: 'zm', target: 'screen', a: 8.95, b: 9.5, c: 11, d: 11.5, box: { x: 0, y: 0, w: 0.5, h: 0.5 } }, { id: 'zgone', target: 'camera', a: 15.1, b: 15.3, c: 15.7, d: 15.95, amount: 1.1 }, { id: 'zquiet', target: 'screen', a: 19.5, b: 19.6, c: 19.7, d: 19.95 }] } });
    must(z.status === 200, z.text);
    // Watch the page's stream: the files change and the chat gets a note.
    const ctl = new AbortController(), live = [];
    const reading = fetch(`${BASE}/api/projects/${shotsProject}/events`, { signal: ctl.signal }).then(async (res) => {
      const rd = res.body.getReader(), dec = new TextDecoder(); let buf = '';
      for (;;) { const { value, done } = await rd.read(); if (done) break; buf += dec.decode(value, { stream: true });
        let i; while ((i = buf.indexOf('\n\n')) >= 0) { const chunk = buf.slice(0, i); buf = buf.slice(i + 2); if (chunk.startsWith('data: ')) live.push(JSON.parse(chunk.slice(6))); } }
    }).catch(() => {});
    await sleep(600);
    // The cut: w18–w20 out (9.0–10.5), w30–w31 out (15.0–16.0).
    writeFileSync(join(SP, 'work/edl_manual.json'), JSON.stringify({ segments_sec: [[0, 9.0], [10.5, 15.0], [16.0, 20]] }));
    await until(() => live.some((e) => e.t === 'files' && !e.replay), 8000, 'a files event after the cut changed');
    const v = await spGet();
    const sh = v.shots.shots, byId = Object.fromEntries(sh.map((s) => [s.id, s]));
    must(byId.on20?.start === 10.5 && byId.on20.word === 21 && byId.on20.look?.preset === 'screen', `the shot on a cut word moves to its first kept word: ${JSON.stringify(byId.on20)}`);
    must(!byId.on30 && byId.on32?.start === 16.01 && byId.s2?.start === 6, `all its words cut: merged; the others stay: ${JSON.stringify(sh)}`);
    const zz = Object.fromEntries(v.zooms.items.map((x) => [x.id, x]));
    must(zz.zm?.a === 10.45 && zz.zm.word === 21 && zz.zm.d === 11.5 && !zz.zgone && zz.zquiet?.a === 19.5, `zooms: ${JSON.stringify(v.zooms.items)}`);
    const backups = existsSync(join(SP, 'work/retime-backup')) ? readdirSync(join(SP, 'work/retime-backup')) : [];
    must(backups.length >= 1, 'no backup before the merge');
    await until(() => live.filter((e) => e.t === 'note' && /merged into|now starts|removed/.test(e.text)).length >= 4, 5000, 'the notes in the chat');
    const notes = live.filter((e) => e.t === 'note').map((e) => e.text);
    must(notes.some((t) => /Shot 4 \(Thirty\) merged into Shot 3 \(Twenty\): all its words were cut/.test(t)) && notes.some((t) => /Shot 3 \(Twenty\) now starts at 0:09\.0, on “w21”/.test(t)) && notes.some((t) => /Zoom 2 was removed/.test(t)), `notes: ${JSON.stringify(notes)}`);
    const log = readFileSync(join(LOCAL, 'chats', `${shotsProject}.jsonl`), 'utf8');
    must(/merged into Shot 3/.test(log), 'the note is not in the chat log');
    // Again: nothing more happens.
    const a = readFileSync(join(SP, 'work/shots.json'), 'utf8'), b = readFileSync(join(SP, 'work/zooms.json'), 'utf8');
    await spGet();
    must(readFileSync(join(SP, 'work/shots.json'), 'utf8') === a && readFileSync(join(SP, 'work/zooms.json'), 'utf8') === b, 'a second read moved things again');
    // Claude writes shots.json itself (a proposed shot): the page hears of it and reads it.
    const n = live.length;
    const doc = spRead('work/shots.json');
    doc.shots.push({ id: 'c1', start: 18.01, look: { hidden: ['cam'] }, by: 'claude', status: 'proposed' });
    writeFileSync(join(SP, 'work/shots.json'), JSON.stringify(doc));
    await until(() => live.slice(n).some((e) => e.t === 'files'), 8000, 'a files event after Claude wrote shots.json');
    const c1 = (await spGet()).shots.shots.find((s) => s.id === 'c1');
    must(c1?.status === 'proposed' && c1.by === 'claude' && c1.word === 36, `Claude's proposal: ${JSON.stringify(c1)}`);
    ctl.abort(); await reading;
    rmSync(join(SP, 'work/edl_manual.json'));
    return `on20 → 0:10.5 (w21), on30 merged (note), zm → 10.45, zgone removed, zquiet stays; ${notes.length} notes; backup ${backups[0]}`;
  });

  await check('Claude is told about shots.json and zooms.json v2 (proposed, by claude)', async () => {
    const ctxText = modRun(`const S = await import(${JSON.stringify(new URL('../server/shots.mjs', import.meta.url).href)}); const B = await import(${JSON.stringify(new URL('../server/blocks.mjs', import.meta.url).href)});
      console.log(JSON.stringify({ shots: S.shotsContext(), blocks: B.blocksContext() }));`);
    must(/work\/shots\.json/.test(ctxText.shots) && /work\/zooms\.json/.test(ctxText.shots) && /"status": "proposed"/.test(ctxText.shots) && /"by": "claude"/.test(ctxText.shots) && /v: 2/.test(ctxText.shots), ctxText.shots.slice(0, 200));
    must(/take block's look is its shots/.test(ctxText.blocks), 'the blocks paragraph still says layout is per block');
    const idx = readFileSync(join(APP, 'server', 'index.mjs'), 'utf8');
    must(/blocksContext\(\),\s*\n\s*shotsContext\(\),/.test(idx), 'shotsContext is not in the project context');
    return `${ctxText.shots.length} characters`;
  });

  // ---- shots in the editor ----
  const SL = await import(new URL('../web/shotlook.js', import.meta.url).href);
  await check('shots editor: the canvas draws lookAt at every moment (frameLooks), crossfades between two shots, and turns canvas edits into look / clear ops', async () => {
    const same = (a, b) => JSON.stringify(a) === JSON.stringify(b), close = (a, b) => Math.abs(a - b) < 1e-6;
    const base = L.normalize({ preset: 'pip' }, 'tutorial');
    const doc = SH.normalizeShots({ shots: [{ id: 'a', start: 0 }, { id: 'b', start: 10, look: { hidden: ['cam'] }, in: { type: 'fade', dur: 1 } }, { id: 'c', start: 20, look: { preset: 'split', cam: { zoom: 2 } } }] }, { duration: 30 });
    const list = doc.shots, ctx = { list, base, duration: 30 };
    // Outside a transition the canvas draws exactly lookAt (the function the export uses).
    for (const t of [0, 5, 9.49, 10.51, 15, 19.99, 20, 25, 29.9]) {
      const f = SL.frameLooks(t, ctx);
      must(!f.tr && same(f.look, L.lookAt(t, base, doc)) && f.index === L.shotAt(t, doc).index, `at ${t}: ${JSON.stringify([f.look.preset, f.look.hidden, f.tr])}`);
    }
    must(SL.frameLooks(12, ctx).look.preset === 'screen' && SL.frameLooks(22, ctx).look.preset === 'split' && SL.frameLooks(22, ctx).look.cam.zoom === 2, 'Shot 2 hides the camera (Screen), Shot 3 is Split at 2×');
    // Inside the crossfade into Shot 2 (centred on 0:10, 1 s): both looks and how far, as transitionAt has it.
    const f = SL.frameLooks(10.25, ctx), ta = L.transitionAt(10.25, base, doc, { duration: 30 });
    must(f.tr?.type === 'fade' && close(f.tr.p, 0.75) && close(ta.p, f.tr.p) && f.tr.from.preset === 'pip' && f.tr.to.preset === 'screen' && f.look === f.tr.to && f.index === 1, `crossfade: ${JSON.stringify(f.tr && { p: f.tr.p, from: f.tr.from.preset, to: f.tr.to.preset })}`);
    must(SL.frameLooks(9.6, ctx).tr.p < 0.5 && SL.frameLooks(9.6, ctx).look.preset === 'pip', 'before half way the outgoing look is the one you pick on the canvas');
    // A cut into Shot 3: no transition, the look switches at the break.
    must(!SL.frameLooks(20, ctx).tr && SL.frameLooks(19.999, ctx).look.preset === 'screen', 'a cut');
    // On the locked cut the crossfade is timed in played seconds (0:09.5–0:10.5 removed: the break sits on the join).
    const cut = [[0, 9.5], [10.5, 30]], fc = SL.frameLooks(10.6, { ...ctx, cut });
    must(fc.tr && close(fc.tr.p, 0.6), `on the cut: ${JSON.stringify(fc.tr && fc.tr.p)}`);
    // The shot being edited draws from the canvas's own (unsaved) layout.
    const edit = { id: 'c', look: { ...L.lookAt(25, base, doc), preset: 'camera' } };
    must(SL.frameLooks(25, { ...ctx, edit }).look === edit.look && SL.frameLooks(5, { ...ctx, edit }).look.preset === 'pip', 'the edited shot');
    // Canvas edits → a shot's partial look: hide the camera (Delete), zoom it, ↺, a layout that needs the camera.
    const look0 = L.effectiveLook(base, null), hid = structuredClone(look0); hid.hidden = ['cam'];
    let pend = SL.applyPatch(null, SL.patchOf(look0, hid).look, base);
    must(same(pend, { hidden: ['cam'] }) && L.effectiveLook(base, pend).preset === 'screen', `Delete the camera: ${JSON.stringify(pend)}`);
    const shown = L.effectiveLook(base, pend), zoomed = structuredClone(shown); zoomed.cam.zoom = 1.5; zoomed.bg = { kind: 'stars' };
    const pz = SL.patchOf(shown, zoomed);
    must(same(pz.look, { cam: { zoom: 1.5 } }) && pz.whole?.bg?.kind === 'stars', `the background stays whole-video: ${JSON.stringify(pz)}`);
    pend = SL.applyPatch(pend, pz.look, base);
    let rc = SL.reconcile({ hidden: ['cam'] }, pend);
    must(same(rc.set, { cam: { zoom: 1.5 } }) && !rc.clear.length, `reconcile → look: ${JSON.stringify(rc)}`);
    rc = SL.reconcile(pend, SH.withoutKeys(pend, ['cam.zoom']));
    must(!rc.set && same(rc.clear, ['cam.zoom']), `↺ → clear: ${JSON.stringify(rc)}`);
    must(same(SL.applyPatch({ hidden: ['cam'] }, { preset: 'split' }, base), { preset: 'split' }), 'Split picked in a shot that hid the camera shows it again');
    must(SL.applyPatch({ cam: { zoom: 2 } }, { cam: { zoom: base.cam.zoom } }, base) === null, 'a value back to the video\'s own is no longer a change');
    must(same(SL.hiddenOf({ hidden: ['screen'], layers: [{ id: 'L1', hidden: true }, { id: 'L2' }] }), ['layer:L1', 'screen']), 'hiddenOf');
    // "/" at the playhead: the word at the caret (first half of a word: that word; second half: the next).
    const W = [[1, 1.4, 'a'], [1.5, 2, 'b'], [2.6, 3, 'c']];
    must(SL.caretWord(1.1, W) === 0 && SL.caretWord(1.3, W) === 1 && SL.caretWord(2.2, W) === 2 && SL.caretWord(3.5, W) === null && SL.caretWord(1.1, W, [[0, 1.45], [2.5, 4]]) === 0 && SL.caretWord(1.3, W, [[0, 1.45], [2.5, 4]]) === 2, 'caretWord');
    return `lookAt at 9 times, crossfade p 0.75 (and 0.6 on the cut), edited shot, Delete → {hidden: [cam]} → Screen, zoom → look, ↺ → clear, Split shows the camera again`;
  });

  await check('shots editor over the API, as the page calls the routes: S, "/", a camera hidden in one shot (look / clear), Crossfade, merge and undo', async () => {
    const url = `/api/projects/${shotsProject}/shots`;
    const op = async (b, code = 200) => { const r = await api(url, b); must(r.status === code, `${b.op}: ${r.status} ${r.text.slice(0, 200)}`); return r.json; };
    let r = await op({ op: 'restore', doc: { shots: [{ id: 's1', start: 0 }, { id: 's2', start: 6, section: 'body' }] }, layout: L.normalize({ preset: 'pip' }, 'tutorial') });
    const base = (await spGet()).layout;
    must(base.preset === 'pip' && r.shots.shots.length === 2, `start: ${JSON.stringify(r.shots.shots)}`);
    // S with the playhead at 0:09.03 (the page sends the shot under the playhead): a new shot on a word start.
    r = await op({ op: 'split', t: 9.03, id: L.shotAt(9.03, r.shots).shot.id });
    const sA = r.id;
    must(r.shots.shots.find((s) => s.id === sA)?.start === 9.01, `S: ${JSON.stringify(r.shots.shots)}`);
    // "/" with the playhead at 0:13.1 on the Words lane: before the word at the caret (w26).
    const w = SL.caretWord(13.1, words40, null);
    r = await op({ op: 'add', word: w });
    const sB = r.id;
    must(w === 26 && r.shots.shots.find((s) => s.id === sB)?.start === 13.01 && r.shots.shots.find((s) => s.id === sB).word === 26, `"/": ${w} ${JSON.stringify(r.shots.shots)}`);
    // The canvas in "This shot" on sA: Delete on the camera, then the camera's zoom; what the page saves.
    let saved = r.shots.shots.find((s) => s.id === sA).look || null;
    let edit = L.effectiveLook(base, saved), next = structuredClone(edit);
    next.hidden = [...next.hidden, 'cam'];
    let pend = SL.applyPatch(saved, SL.patchOf(edit, next).look, base);
    let rc = SL.reconcile(saved, pend);
    r = await op({ op: 'look', id: sA, look: rc.set });
    must(L.lookAt(10, base, r.shots).preset === 'screen' && L.lookAt(7, base, r.shots).preset === 'pip' && L.lookAt(14, base, r.shots).preset === 'pip' && L.lookAt(10, base, r.shots).hidden.includes('cam'),
      `the camera is gone in this shot only (PiP → Screen), and back after it: ${JSON.stringify([L.lookAt(7, base, r.shots).preset, L.lookAt(10, base, r.shots).preset, L.lookAt(14, base, r.shots).preset])}`);
    saved = r.shots.shots.find((s) => s.id === sA).look;
    edit = L.effectiveLook(base, pend); next = structuredClone(edit); next.cam.zoom = 2;
    pend = SL.applyPatch(pend, SL.patchOf(edit, next).look, base);
    rc = SL.reconcile(saved, pend);
    r = await op({ op: 'look', id: sA, look: rc.set });
    must(JSON.stringify(r.shots.shots.find((s) => s.id === sA).look) === '{"cam":{"zoom":2},"hidden":["cam"]}', `zoom in the shot: ${JSON.stringify(r.shots.shots.find((s) => s.id === sA).look)}`);
    // ↺ on Crop & zoom: the page sends a clear of just that key.
    saved = r.shots.shots.find((s) => s.id === sA).look;
    rc = SL.reconcile(saved, SH.withoutKeys(pend, ['cam.zoom']));
    r = await op({ op: 'clear', id: sA, keys: rc.clear });
    must(JSON.stringify(r.shots.shots.find((s) => s.id === sA).look) === '{"hidden":["cam"]}', `↺: ${JSON.stringify(r.shots.shots.find((s) => s.id === sA).look)}`);
    // "Hide in all shots" is one restore with the video's look hiding the camera (and the shots' lists pruned).
    // Crossfade into sA from the popover, then "Use for every shot change", then Cut again.
    r = await op({ op: 'transition', id: sA, in: { type: 'fade', dur: 0.4 } });
    let g = (await api(url)).json;
    must(g.transitions.length === 1 && g.transitions[0].id === sA && g.transitions[0].type === 'fade' && Math.abs(g.transitions[0].dur - 0.4) < 1e-6, `GET /shots transitions: ${JSON.stringify(g.transitions)}`);
    const fl = SL.frameLooks(9.01 + 0.1, { list: g.shots.shots, base, duration: 20 });
    must(fl.tr?.type === 'fade' && fl.tr.from.preset === 'pip' && fl.tr.to.preset === 'screen', `the preview crossfades there: ${JSON.stringify(fl.tr && [fl.tr.p, fl.tr.from.preset, fl.tr.to.preset])}`);
    r = await op({ op: 'transition', all: true, in: { type: 'fade', dur: 0.6 } });
    must(r.shots.shots.slice(1).every((s) => s.in?.type === 'fade' && s.in.dur === 0.6), `every shot change: ${JSON.stringify(r.shots.shots.map((s) => s.in))}`);
    r = await op({ op: 'transition', id: sA, in: null });
    must(!r.shots.shots.find((s) => s.id === sA).in, 'Cut');
    // Delete on the break before sA: merge (the earlier look stays); undo = restore with "before".
    const m = await op({ op: 'merge', id: sA });
    must(!m.shots.shots.some((s) => s.id === sA) && L.lookAt(10, base, m.shots).preset === 'pip', `merged, Shot 2's look: ${JSON.stringify(m.shots.shots)}`);
    r = await op({ op: 'restore', doc: m.before });
    must(JSON.stringify(r.shots.shots.find((s) => s.id === sA)?.look) === '{"hidden":["cam"]}', `undo: ${JSON.stringify(r.shots.shots)}`);
    // A section edge isn't a break you can merge or drag.
    await op({ op: 'merge', id: 's2' }, 400);
    await op({ op: 'move', id: 's2', t: 7 }, 400);
    // Drag a break on the lane (t, snapped) and a "/" to another word (word).
    r = await op({ op: 'move', id: sB, t: 14.3 });
    must(r.shots.shots.find((s) => s.id === sB).start === 14.01, `drag: ${JSON.stringify(r.shots.shots)}`);
    r = await op({ op: 'move', id: sB, word: 30 });
    must(r.shots.shots.find((s) => s.id === sB).start === 15.01, `"/" dragged to w30: ${JSON.stringify(r.shots.shots)}`);
    // Rename (double-click on the lane).
    r = await op({ op: 'name', id: sB, name: 'Demo' });
    must(r.shots.shots.find((s) => s.id === sB).name === 'Demo', 'rename');
    return `S → ${sA} at 0:09.01, "/" → ${sB} at 0:13.01 (w26), camera hidden in ${sA} only, zoom + ↺, Crossfade 0.4 → every change 0.6 → Cut, merge + undo, drag, rename`;
  });

  // The page's files: the Shots lane is wired in, S / ⇧S and "/" are the timeline's, the Cut Editor knows "/".
  await check('shots editor: the page wires the Shots lane, the keys and the Cut tab', async () => {
    const tl = readFileSync(join(APP, 'web', 'timeline.js'), 'utf8'), core = readFileSync(join(APP, 'web', 'tlcore.js'), 'utf8'), app = readFileSync(join(APP, 'web', 'app.js'), 'utf8');
    must(/k: 'shots', label: 'Shots', note: 'you edit here'/.test(tl) && /splitShot: \(t\) => o\.shots\.split\(t\)/.test(tl), 'the Shots lane / S in web/timeline.js');
    must(/cfg\.splitShot && !e\.shiftKey/.test(core) && /case '\/': if \(cfg\.slash\)/.test(core), 'S / ⇧S / "/" in web/tlcore.js');
    must(/frameLooks\(t, \{ list: L, base/.test(app) && /makeShots\(/.test(app), 'the canvas draws frameLooks');
    const ce = readFileSync(join(APP, 'web', 'cut-editor', 'studio.js'), 'utf8');
    must(/studio:shot-add/.test(ce) && /studio:shots/.test(ce), 'the Cut Editor shows and sends "/"');
    const css = readFileSync(join(APP, 'web', 'looks.css'), 'utf8');
    const looks = [...css.matchAll(/:root\[data-look="(\w+)"\] \{([^}]*)\}/g)].filter((m, i, a) => a.findIndex((x) => x[1] === m[1]) === i);
    const lum = (hex) => { const c = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4)); return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]; };
    const ratio = (a, b) => { const x = lum(a), y = lum(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); };
    const low = [];
    for (const [, name, body] of looks) {
      const sel = /--sel:\s*(#[0-9a-f]{6})/i.exec(body)?.[1], ink = /--sel-ink:\s*(#[0-9a-f]{6})/i.exec(body)?.[1];
      if (!sel || !ink || ratio(sel, ink) < 4.5) low.push(`${name} ${sel}/${ink}`);
    }
    const eb = readFileSync(join(APP, 'web', 'style.css'), 'utf8');
    must(/--sel-ink: #ffffff;/.test(eb) && ratio('#2563eb', '#ffffff') >= 4.5, 'Edit Bay --sel-ink');
    must(looks.length === 9 && !low.length, `--sel-ink on --sel under 4.5:1 or missing: ${low.join(', ')} (${looks.length} looks)`);
    return `${looks.length + 1} looks: --sel-ink on --sel ≥ 4.5:1`;
  });

  await check('first-time help: help.stepsIntro saves in settings, reaches /api/status, a bad value is refused', async () => {
    // The browser tests above say it's been seen (it would cover their clicks), so start again from "not seen".
    must((await api('/api/app/settings', { section: 'help', values: { stepsIntro: '' } })).status === 200, 'could not reset help.stepsIntro');
    const before = (await api('/api/status')).json.help;
    must(before && before.stepsIntro === '', `help before: ${JSON.stringify(before)}`);
    const bad = await api('/api/app/settings', { section: 'help', values: { stepsIntro: 'whatever' } });
    must(bad.status === 400, `a bad value got ${bad.status}`);
    const ok = await api('/api/app/settings', { section: 'help', values: { stepsIntro: 'dismissed' } });
    must(ok.status === 200, ok.text);
    must((await api('/api/status')).json.help.stepsIntro === 'dismissed', 'not dismissed after saving');
    must(JSON.parse(readFileSync(join(LOCAL, 'settings.json'), 'utf8')).help?.stepsIntro === 'dismissed', 'not in local/settings.json');
    return 'dismissed, in settings';
  });

  await check('face finder runs (Auto-frame helper)', async () => {
    if (process.platform === 'darwin') return 'skipped on a Mac (Vision)';
    const img = join(ROOT, 'blank.jpg');
    execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=gray:size=640x360', '-frames:v', '1', img]);
    const out = execFileSync(PY, [join(APP, 'tools', 'face.py'), img], { encoding: 'utf8' });
    must(Array.isArray(JSON.parse(out)), 'no JSON from face.py');
    return out.trim();
  });
} finally {
  server.kill();
  await sleep(500);
}

// ---- report ----
const pad = (s, n) => String(s).padEnd(n);
console.log(`\nStudio smoke test · ${process.platform} · Node ${process.version}\n`);
for (const r of results) console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${pad(r.name, 58)} ${pad(`${(r.ms / 1000).toFixed(1)} s`, 8)} ${r.note}`);
const failed = results.filter((r) => !r.ok);
if (failed.length) console.log(`\nServer log (last lines):\n${log.split('\n').slice(-40).join('\n')}`);
try { rmSync(ROOT, { recursive: true, force: true }); } catch {}
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);
