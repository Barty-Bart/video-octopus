// Real generated-scene/background renderer checks against disposable synthetic files.
// CHROMIUM_PATH=/path/to/cached/chromium FFMPEG_PATH=/path/to/ffmpeg FFPROBE_PATH=/path/to/ffprobe node test/generated-rendering.e2e.mjs
// No model, package installation, creator studio, external service or source-repository write.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';
import { deflateSync, crc32 } from 'node:zlib';
import { createHash } from 'node:crypto';

const source = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const chrome = process.env.CHROMIUM_PATH, ffmpeg = process.env.FFMPEG_PATH, ffprobe = process.env.FFPROBE_PATH;
for (const [name, value] of Object.entries({ CHROMIUM_PATH: chrome, FFMPEG_PATH: ffmpeg, FFPROBE_PATH: ffprobe }))
  assert(value && existsSync(value), `Supply an already installed ${name}; this test never downloads tools.`);
const reportPath = process.env.RENDER_SECURITY_REPORT;
const root = realpathSync(mkdtempSync(join(tmpdir(), 'octopus-generated-rendering-')));
const app = join(root, 'app'), home = join(root, 'home'), local = join(root, 'local'), studio = join(root, 'studio');
const project = join(studio, 'projects', 'fixture');
const originalEnv = { ...process.env };
const report = { at: new Date().toISOString(), node: process.version, platform: process.platform, arch: process.arch, checks: [], requests: [] };
const began = Date.now();
let trap, renderHost, backgroundRoutes, createSandbox, renderingOrigin;
const sandboxScopes = [];
const put = (p, data) => { mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, data); };
const json = (p, value) => put(p, JSON.stringify(value, null, 2) + '\n');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const listen = async (s) => { await new Promise((ok, fail) => { s.once('error', fail); s.listen(0, '127.0.0.1', ok); }); return `http://127.0.0.1:${s.address().port}`; };
const close = (s) => !s?.listening ? Promise.resolve() : new Promise((done) => { s.closeAllConnections?.(); s.close(done); });
const check = async (name, fn) => {
  try { const evidence = await fn(); report.checks.push({ name, passed: true, ...(evidence ? { evidence } : {}) }); console.log(`[generated rendering] PASS ${name}`); }
  catch (e) { report.checks.push({ name, passed: false, error: e.stack || e.message }); console.error(`[generated rendering] FAIL ${name}: ${e.message}`); }
};
function png(W, H, rgba) {
  const raw = Buffer.alloc((W * 4 + 1) * H);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) for (let k = 0; k < 4; k++) raw[y * (W * 4 + 1) + x * 4 + 1 + k] = rgba[k];
  const chunk = (kind, bytes) => { const head = Buffer.alloc(4), sum = Buffer.alloc(4), data = Buffer.concat([Buffer.from(kind), bytes]); head.writeUInt32BE(bytes.length); sum.writeUInt32BE(crc32(data) >>> 0); return Buffer.concat([head, data, sum]); };
  const h = Buffer.alloc(13); h.writeUInt32BE(W); h.writeUInt32BE(H, 4); h[8] = 8; h[9] = 6;
  return Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]), chunk('IHDR', h), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}
const pixels = (buf) => execFileSync(ffmpeg, ['-v', 'error', '-f', 'image2pipe', '-i', 'pipe:0', '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgba', 'pipe:1'], { input: buf, maxBuffer: 8e6 });
const pixel = (buf, x, y, width = 160) => [...buf.subarray((y * width + x) * 4, (y * width + x) * 4 + 4)];
const near = (actual, expected, tolerance = 2) => assert(actual.every((v, i) => Math.abs(v - expected[i]) <= tolerance), `${actual} != ${expected}`);

try {
  for (const p of [app, home, local, project]) mkdirSync(p, { recursive: true });
  const runtimePaths = ['server', 'web', 'core', 'starter', 'bin', 'package.json'];
  for (const p of runtimePaths) cpSync(join(source, p), join(app, p), { recursive: true, dereference: false });
  report.sceneRendererSha256 = createHash('sha256').update(readFileSync(join(app, 'server/scene-frames.mjs'))).digest('hex');
  report.backgroundRendererSha256 = createHash('sha256').update(readFileSync(join(app, 'server/backgrounds.mjs'))).digest('hex');
  report.sourceSha256 = Object.fromEntries(['server/scene-frames.mjs', 'server/backgrounds.mjs', 'server/generated-sandbox.mjs', 'server/sandbox-scene-bridge.js',
    'server/sandbox-background-bridge.js', 'web/sandbox-painter.js', 'web/bg-render.html', 'web/look.js'].map((p) => [p, createHash('sha256').update(readFileSync(join(app,p))).digest('hex')]));
  const clean = { HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: join(home, '.config'), XDG_CACHE_HOME: join(home, '.cache'),
    CODEX_HOME: join(home, '.codex'), CLAUDE_CONFIG_DIR: join(home, '.claude'), PI_CODING_AGENT_DIR: join(home, '.pi'),
    PATH: [dirname(process.execPath), '/usr/bin', '/bin'].join(':'), TMPDIR: root, STUDIO_LOCAL_DIR: local,
    STUDIO_NO_SCHEDULES: '1', STUDIO_NO_OPEN: '1', LANG: 'en_US.UTF-8' };
  for (const key of Object.keys(process.env)) delete process.env[key];
  Object.assign(process.env, clean);
  json(join(local, 'settings.json'), { studio, chrome, ffmpeg, ffprobe, updates: { auto: false }, setup: { done: true }, permissionMode: 'manual' });
  json(join(project, 'project.json'), { name: 'Synthetic generated rendering', type: 'tutorial' });
  put(join(root, 'outside-secret.json'), '{"sentinel":"outside-fixture-root-secret"}\n');
  put(join(studio, 'projects/outside-secret.json'), '{"sentinel":"sibling-fixture-secret"}\n');
  trap = createServer((req, res) => { report.requests.push({ method: req.method, path: req.url }); res.setHeader('Access-Control-Allow-Origin', '*'); res.setHeader('Content-Type', 'application/json'); res.end('{"sentinel":"network-fixture-secret"}'); });
  trap.on('upgrade', (req, socket) => { report.requests.push({ method: 'UPGRADE', path: req.url }); socket.destroy(); });
  const trapBase = await listen(trap);

  // A minimal trusted host for the production background page/route. It does not
  // replace the renderer, sandbox server, browser security or frame encoder.
  // The full app API/preview boundary has its own security-boundaries.e2e test.
  const send = (res, status, data) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(data)); };
  renderHost = createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://fixture');
      if (url.pathname.startsWith('/api/bgjob/')) return await backgroundRoutes(req, res, url.pathname, send);
      if (url.pathname === '/api/sandbox' && req.method === 'POST') {
        let body = ''; for await (const part of req) body += part;
        const spec = JSON.parse(body), src = new URL(spec.src, `http://127.0.0.1:${renderHost.address().port}`);
        assert.equal(spec.kind, 'background');
        const expected = '/api/projects/fixture/files/assets/'; assert(src.pathname.startsWith(expected));
        const name = decodeURIComponent(src.pathname.slice(expected.length)); assert(/^[a-z0-9-]+\.js$/.test(name));
        const scope = await createSandbox({ root: project, file: join(project, 'assets', name), kind: 'background' }); sandboxScopes.push(scope);
        return send(res, 200, { url: scope.url });
      }
      if (url.pathname.startsWith('/api/')) { report.requests.push({ method: req.method, path: `render-host${url.pathname}` }); return send(res, 403, { error: 'No fixture API capability' }); }
      const rel = url.pathname.startsWith('/kit/') ? join('core', url.pathname.slice(1)) : join('web', url.pathname.slice(1));
      const file = resolve(app, rel); assert(file.startsWith(app + '/')); assert(existsSync(file));
      const type = file.endsWith('.html') ? 'text/html' : file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : 'application/octet-stream';
      res.writeHead(200, { 'Content-Type': type, ...(type === 'text/html' ? { 'Content-Security-Policy': `frame-src 'self' ${renderingOrigin}; object-src 'none'` } : {}) }); res.end(readFileSync(file));
    } catch (e) { send(res, 500, { error: e.message }); }
  });
  await listen(renderHost); process.env.PORT = String(renderHost.address().port);

  const { openScene } = await import(pathToFileURL(join(app, 'server/scene-frames.mjs')));
  const sandboxModule = await import(pathToFileURL(join(app, 'server/generated-sandbox.mjs')));
  createSandbox = sandboxModule.createSceneSandbox; renderingOrigin = await sandboxModule.sandboxOrigin();
  const { backgroundPlan, bgJobRoute, backgroundsBusy } = await import(pathToFileURL(join(app, 'server/backgrounds.mjs'))); backgroundRoutes = bgJobRoute;
  put(join(project, 'assets/swatch.png'), png(8, 8, [255, 220, 0, 255]));
  cpSync(join(app, 'core/kit/octopus-scene.js'), join(project, 'assets/octopus-scene.js'));
  cpSync(join(app, 'web/fonts/jetbrains-mono-latin-wght-normal.woff2'), join(project, 'assets/font.woff2'));
  json(join(project, 'work/production.json'), { scenes: [{ id: 's1', start: 0, end: 1 }] });
  json(join(project, 'work/overrides.json'), { v: 1, scenes: { s1: { box: { keys: [{ t: 0, dx: 0, dy: 0, s: 1, o: 1, e: 'linear' }, { t: 1, dx: 20, dy: 0, s: 1, o: 1 }] } } } });
  put(join(project, 'positive.html'), `<!doctype html><style>html,body{margin:0;background:transparent;overflow:hidden}@font-face{font-family:Fixture;src:url(assets/font.woff2)}canvas{display:block}</style><canvas width="160" height="90"></canvas>
<script src="assets/octopus-scene.js"></script><script>
const canvas=document.querySelector('canvas'),g=Octopus.use(canvas.getContext('2d'));Octopus.layers=['main','image'];
const sprite=new Image();sprite.src='assets/swatch.png';window.ready=Promise.all([sprite.decode(),document.fonts.load('12px Fixture')]);
window.seek=(t,layer)=>{g.clearRect(0,0,160,90);if(!layer||layer==='main')Octopus.el('box',[10,10,20,20],()=>{g.fillStyle=t<0.75?'rgb(230,20,30)':'rgb(20,210,60)';g.fillRect(10,10,20,20)},{label:'Fixture box',in:0,out:1});if(!layer||layer==='image')Octopus.el('image',[100,10,16,16],()=>g.drawImage(sprite,100,10,16,16),{label:'Fixture sprite'});};
</script>`);
  await check('headless scene loads local image/font/kit and applies saved keyframes with transparent pixels', async () => {
    let scene;
    try {
      scene = await openScene({ file: join(project, 'positive.html'), root: project, W: 160, H: 90 });
      assert.equal(scene.info.kit, 3); assert.deepEqual(scene.info.layers, ['main', 'image']);
      const frame = await scene.frame(0.5, 'main', { hits: true }); assert(frame.png);
      const px = pixels(frame.png); near(pixel(px, 25, 15), [230,20,30,255]); near(pixel(px, 5, 5), [0,0,0,0]);
      assert(frame.hits.some((h) => h[0] === 'box' && h[2] === 's1' && Math.abs(h[3] - 20) < 0.1));
      const image = await scene.frame(0.5, 'image', { hits: true }); near(pixel(pixels(image.png), 105, 15), [255,220,0,255]);
      return { layers: scene.info.layers, keyedX: frame.hits.find((h) => h[0] === 'box')[3] };
    } finally { scene?.close(); }
  });
  await check('headless scene seeking and element isolation produce distinct deterministic frames', async () => {
    let scene;
    try {
      scene = await openScene({ file: join(project, 'positive.html'), root: project, W: 160, H: 90 });
      const a = await scene.frame(0, 'main', { only: 'box', hits: true }); near(pixel(pixels(a.png), 15,15), [230,20,30,255]);
      const b = await scene.frame(1, 'main', { only: 'box', hits: true }); near(pixel(pixels(b.png), 35,15), [20,210,60,255]);
      const hidden = await scene.frame(0, 'main', { only: 'not-present', hits: false }); assert.equal(hidden.png, null);
      const measured = await scene.frame(0.5, 'main', { hits: true, shot: false }); assert.equal(measured.png, null); assert(measured.hits.length > 0);
    } finally { scene?.close(); }
  });

  // Each prohibited network attempt targets our own sentinel listener, never an external service.
  const attempts = `
let exposed=false;const jobs=[];
for(const u of [${JSON.stringify(`${trapBase}/api/projects/other/files/sentinel.json`)},${JSON.stringify(pathToFileURL(join(root,'outside-secret.json')).href)},'assets/outside-link.json','../outside-secret.json'])jobs.push(fetch(u).then(r=>r.text()).then(t=>{if(t.includes('secret'))exposed=true}).catch(()=>{}));
jobs.push(fetch(${JSON.stringify(`${trapBase}/api/settings`)},{method:'POST',headers:{'Content-Type':'application/json','X-Studio':'1'},body:'{"model":"must-not-change"}'}).catch(()=>{}));
try{navigator.sendBeacon(${JSON.stringify(`${trapBase}/beacon`)},'synthetic')}catch{}
try{const image=new Image();image.src=${JSON.stringify(`${trapBase}/image`)}}catch{}
try{const ws=new WebSocket(${JSON.stringify(trapBase.replace('http:', 'ws:') + '/socket')});setTimeout(()=>ws.close(),100)}catch{}
try{new Worker(${JSON.stringify(`${trapBase}/worker.js`)})}catch{}
try{const f=document.createElement('iframe');f.src=${JSON.stringify(`${trapBase}/nested-frame`)};document.body.append(f)}catch{}
try{window.open(${JSON.stringify(`${trapBase}/popup`)})}catch{}
`;
  symlinkSync(join(root, 'outside-secret.json'), join(project, 'assets/outside-link.json'));
  put(join(project, 'hostile.html'), `<!doctype html><style>html,body{margin:0}</style><canvas width="160" height="90"></canvas><script>${attempts}
window.ready=Promise.allSettled(jobs);window.seek=()=>{const g=document.querySelector('canvas').getContext('2d');g.fillStyle=exposed?'#ff0000':'#00cc00';g.fillRect(0,0,160,90)};</script>`);
  await check('headless scene cannot read outside files or reach privileged localhost APIs and network sinks', async () => {
    let scene;
    const before = report.requests.length;
    try {
      scene = await openScene({ file: join(project, 'hostile.html'), root: project, W: 160, H: 90 });
      const frame = await scene.frame(0, null, { hits: false }); near(pixel(pixels(frame.png), 20,20), [0,204,0,255]);
      await sleep(300); assert.deepEqual(report.requests.slice(before), []);
    } finally { scene?.close(); }
  });
  put(join(project, 'navigate.html'), `<!doctype html><canvas width="160" height="90"></canvas><script>window.seek=()=>{};window.ready=Promise.resolve();setTimeout(()=>location.href=${JSON.stringify(`${trapBase}/self-navigation?sentinel=synthetic`)},600);</script>`);
  await check('headless scene self-navigation cannot contact another localhost origin', async () => {
    let scene;const before=report.requests.length;
    try {
      scene=await openScene({file:join(project,'navigate.html'),root:project,W:160,H:90});
      await sleep(1000);assert.deepEqual(report.requests.slice(before),[]);
    } finally {scene?.close();}
  });

  const videoPixels = (file, frame) => execFileSync(ffmpeg, ['-v', 'error', '-i', file, '-vf', `select=eq(n\\,${frame})`, '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgba', 'pipe:1'], { maxBuffer: 8e6 });
  const renderBackground = async (file, tag, frames = 5) => {
    const jobRel = `work/${tag}`; mkdirSync(join(project, jobRel), { recursive: true });
    const plan = backgroundPlan('fixture', project, { bg: { kind: 'code', file, name: 'Synthetic generated background' } }, { W: 160, H: 90, total: (frames - 1) / 30, jobRel });
    const task = plan.prepare();
    try { await task.done; return join(project, plan.file); } finally { task.cancel(); }
  };
  put(join(project, 'assets/bg-positive.js'), `export default {name:'Synthetic time colours',async draw(g,W,H,t){await new Promise(r=>setTimeout(r,15+(Math.round(t*30)%3)*10));g.fillStyle=t<0.05?'rgb(220,30,40)':'rgb(10,190,80)';g.fillRect(0,0,W,H);g.fillStyle='rgb(30,50,230)';g.fillRect(Math.round(t*30)*10,0,6,H);}};\n`);
  await check('real generated-background export encodes every requested time in order', async () => {
    const out = await renderBackground('assets/bg-positive.js', 'background-positive');
    const meta = JSON.parse(execFileSync(ffprobe, ['-v','error','-count_frames','-select_streams','v:0','-show_entries','stream=width,height,nb_read_frames','-of','json',out], { encoding:'utf8' }));
    assert.equal(meta.streams[0].width,160); assert.equal(meta.streams[0].height,90); assert.equal(Number(meta.streams[0].nb_read_frames),5);
    for (let frame=0;frame<5;frame++) {
      const px=videoPixels(out,frame); near(pixel(px,frame*10+2,20),[30,50,230,255]);
      near(pixel(px,120,20),frame<2?[220,30,40,255]:[10,190,80,255]);
    }
    return { width:160,height:90,frames:5 };
  });
  put(join(project, 'assets/bg-hostile.js'), `${attempts}\nawait Promise.allSettled(jobs);export default {name:'Synthetic hostile background',draw(g,W,H,t){g.fillStyle=exposed?'#ff0000':'#00cc00';g.fillRect(0,0,W,H);}};\n`);
  await check('generated-background export cannot read outside files or reach privileged APIs/network sinks', async () => {
    const before=report.requests.length;
    const out=await renderBackground('assets/bg-hostile.js','background-hostile',3);
    near(pixel(videoPixels(out,0),20,20),[0,204,0,255]);
    await sleep(300);assert.deepEqual(report.requests.slice(before),[]);
  });
  put(join(project, 'assets/bg-navigate.js'), `export default {name:'Synthetic navigation attempt',async draw(g,W,H,t){location.href=${JSON.stringify(`${trapBase}/background-self-navigation?sentinel=synthetic`)};await new Promise(r=>setTimeout(r,100));g.fillStyle='#00cc00';g.fillRect(0,0,W,H);}};\n`);
  await check('generated-background self-navigation is blocked and terminates the export cleanly', async () => {
    const before=report.requests.length;
    // A blocked document navigation may replace the malicious frame with a CSP error
    // document. A bounded renderer error is correct here; rendering malicious code
    // successfully after it discards its own document is not required.
    const start=Date.now();
    let failure;
    await assert.rejects(renderBackground('assets/bg-navigate.js','background-navigate',2),(e)=>{failure=e.message;return /background.*(?:longer|stopped|failed)/i.test(e.message);});
    assert(Date.now()-start<25000,'Blocked navigation must fail within its frame timeout.');
    assert.deepEqual(report.requests.slice(before),[]);
    assert.equal(backgroundsBusy(),false);
    return { failedClosed:failure };
  });
  await check('all generated renderer attempts left sentinel files and fixture APIs unchanged', async () => {
    assert.deepEqual(report.requests, []);
    assert.equal(readFileSync(join(root,'outside-secret.json'),'utf8'),'{"sentinel":"outside-fixture-root-secret"}\n');
    assert.equal(readFileSync(join(local,'settings.json'),'utf8').includes('must-not-change'),false);
  });
} catch (e) {
  report.error = e.stack || e.message;
} finally {
  for (const scope of sandboxScopes) await scope.dispose();
  await close(renderHost); await close(trap);
  // openScene.close schedules exact child/profile cleanup.
  await sleep(1700);
  const leakedChildren=process._getActiveHandles().filter((h)=>h.constructor.name==='ChildProcess'&&h.exitCode===null&&h.signalCode===null);
  await check('renderers terminate their child processes after successful and failed exports',async()=>{
    assert.deepEqual(leakedChildren.map((h)=>h.pid),[],'Renderer child processes must finish after cleanup.');
  });
  // A regression must not leave its own test children running. Never signal a
  // process by a broad name or PID discovered outside this test process.
  for(const child of leakedChildren){child.stdin?.destroy();try{child.kill('SIGKILL');}catch{}}
  report.failed = report.checks.filter((c) => !c.passed).length + Number(Boolean(report.error));
  report.elapsedMs = Date.now() - began;
  for (const key of Object.keys(process.env)) delete process.env[key]; Object.assign(process.env, originalEnv);
  rmSync(root, { recursive: true, force: true }); report.fixtureRemoved = !existsSync(root);
  if (reportPath) json(resolve(reportPath), report);
  console.log(JSON.stringify(report, null, 2));
  process.exitCode = report.failed ? 1 : 0;
}
