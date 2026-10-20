// Runner-only integration check. Importing this file has no application/media side effects.
// Requires Node >=20, an already-running app with a disposable studio, and FFmpeg/ffprobe.
// ffmpeg/ffprobe: pass the binary paths discovered by the app's setup harness; omitted
// values use PATH in the caller's runner environment. Never substitute a test-only codec.
// record(name, status, details) may be async; status is pass/fail/blocked/info.
// Returns {project, results, ok}; local files are ephemeral runner evidence, not uploads.
// Failure details include export job metadata and SSE errors for CI logs/summary.
import { execFile } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { deflateSync } from 'node:zlib';
import { promisify } from 'node:util';

const execute = promisify(execFile);
const SECONDS = 2;
const JOB_TIMEOUT = 120_000;
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
const crcTable = Array.from({ length: 256 }, (_, i) => {
  let c = i;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

// Solid RGBA PNGs replace browser canvas masks; geometry still comes from app compose().
function solidPng(w, h, color) {
  if (![w, h].every((n) => Number.isInteger(n) && n > 0 && n <= 4096)) throw new Error(`Invalid PNG size ${w}x${h}`);
  const stride = w * 4 + 1, raw = Buffer.alloc(stride * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const offset = y * stride + 1 + x * 4;
    for (let c = 0; c < 4; c++) raw[offset + c] = color[c];
  }
  const chunk = (name, bytes) => {
    const body = Buffer.concat([Buffer.from(name), bytes]), size = Buffer.alloc(4), crc = Buffer.alloc(4);
    size.writeUInt32BE(bytes.length);
    let c = 0xffffffff;
    for (const b of body) c = crcTable[(c ^ b) & 255] ^ (c >>> 8);
    crc.writeUInt32BE((c ^ 0xffffffff) >>> 0);
    return Buffer.concat([size, body, crc]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(w); header.writeUInt32BE(h, 4); header[8] = 8; header[9] = 6;
  const bytes = Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', header), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
  return `data:image/png;base64,${bytes.toString('base64')}`;
}

export async function checkExports({ repo, baseUrl, evidenceDir, record, ffmpeg = 'ffmpeg', ffprobe = 'ffprobe' }) {
  const results = [], root = resolve(evidenceDir), base = new URL(baseUrl);
  let project = null, view = null, fixture = null, toolsReady = false, lastExport = null;
  // This intentionally accepts loopback only: callers must start an isolated local app.
  if (!['127.0.0.1', 'localhost', '[::1]'].includes(base.hostname)) {
    const result = { name: 'export setup', status: 'blocked', details: 'baseUrl must be a loopback disposable CI app.' };
    await record(result.name, result.status, result.details);
    return { project, results: [result], ok: false };
  }
  await mkdir(root, { recursive: true });
  const save = (name, value) => writeFile(join(root, name), typeof value === 'string' ? value : JSON.stringify(value, null, 2));
  const note = async (name, status, details) => {
    results.push({ name, status, details });
    await save('export-results.json', { project, results });
    await record(name, status, details);
  };
  const command = async (name, bin, args, timeout = 30_000) => {
    try {
      const out = await execute(bin, args, { timeout, maxBuffer: 4 * 1024 * 1024, windowsHide: true });
      await save(`${name}.json`, { bin, args, stdout: out.stdout, stderr: out.stderr });
      return out.stdout;
    } catch (error) {
      await save(`${name}.json`, { bin, args, code: error.code, killed: error.killed, message: error.message,
        stdout: error.stdout || '', stderr: error.stderr || '' });
      throw error;
    }
  };
  const api = async (path, body) => {
    const response = await fetch(new URL(path, base), {
      method: body === undefined ? 'GET' : 'POST', signal: AbortSignal.timeout(10_000),
      headers: { 'X-Studio': '1', ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const text = await response.text();
    if (!response.ok) throw new Error(`${path}: HTTP ${response.status}: ${text.slice(0, 1500)}`);
    try { return JSON.parse(text); } catch { throw new Error(`${path}: expected JSON: ${text.slice(0, 200)}`); }
  };
  const probe = async (name, file) => JSON.parse(await command(name, ffprobe, [
    '-v', 'error', '-show_entries', 'stream=codec_type,codec_name,sample_rate,width,height:format=duration', '-of', 'json', file,
  ]));
  const duration = (data) => {
    const seconds = Number(data.format?.duration);
    if (!Number.isFinite(seconds) || Math.abs(seconds - SECONDS) > 0.2) throw new Error(`Expected ${SECONDS}s, got ${seconds}s`);
    return seconds;
  };
  const stage = async (name, fn, ready = true) => {
    if (!ready) { await note(name, 'blocked', 'A prerequisite failed; see earlier results.'); return false; }
    try { await note(name, 'pass', await fn()); return true; }
    catch (error) {
      if (!error.details && name.endsWith(' export') && lastExport) error.details = await failedJobEvidence(lastExport.started, lastExport.events);
      await note(name, 'fail', { message: error.message, code: error.code || null, ...(error.details || {}) });
      return false;
    }
  };
  const projectPath = () => `/api/projects/${encodeURIComponent(project)}`;
  const watchJobs = async () => {
    const controller = new AbortController(), events = [];
    const timer = setTimeout(() => controller.abort(), 10_000);
    let response;
    try { response = await fetch(new URL(`${projectPath()}/events`, base), {
      headers: { 'X-Studio': '1' }, signal: controller.signal,
    }); } finally { clearTimeout(timer); }
    if (!response.ok || !response.body) { controller.abort(); throw new Error(`Events HTTP ${response.status}`); }
    const done = (async () => {
      let buffer = '';
      const decoder = new TextDecoder();
      try {
        for await (const chunk of response.body) {
          buffer += decoder.decode(chunk, { stream: true });
          let end;
          while ((end = buffer.indexOf('\n\n')) >= 0) {
            const message = buffer.slice(0, end); buffer = buffer.slice(end + 2);
            for (const line of message.split('\n')) if (line.startsWith('data:')) {
              try {
                const event = JSON.parse(line.slice(5));
                if (event.t === 'job' && event.id === 'export') { events.push(event); if (events.length > 30) events.shift(); }
              } catch {}
            }
          }
        }
      } catch (error) { if (!controller.signal.aborted) events.push({ streamError: error.message }); }
    })();
    return { events, close: async () => { controller.abort(); await done; } };
  };
  const failedJobEvidence = async (started, events) => {
    const details = { started, events, note: 'No run.log/error file is written by these export paths; terminal errors arrive as SSE job events.' };
    if (/^work\/export\/[\w-]+$/.test(started?.job || '')) {
      for (const name of ['job.json', 'run.sh']) {
        const file = `${started.job}/${name}`;
        try {
          const response = await fetch(new URL(`${projectPath()}/files/${file}`, base), {
            headers: { 'X-Studio': '1' }, signal: AbortSignal.timeout(5000),
          });
          details[name] = response.ok ? (await response.text()).slice(0, 24_000)
            : `Not available (HTTP ${response.status}); audio job metadata is written only on success.`;
        } catch (error) { details[name] = `Could not read: ${error.message}`; }
      }
    }
    return details;
  };
  const download = async (relative, filename) => {
    if (typeof relative !== 'string' || !relative.startsWith('renders/') || relative.includes('..')) throw new Error('Invalid export output path');
    const url = `${projectPath()}/files/${relative.split('/').map(encodeURIComponent).join('/')}`;
    const response = await fetch(new URL(url, base), { headers: { 'X-Studio': '1' }, signal: AbortSignal.timeout(15_000) });
    if (!response.ok) throw new Error(`Export download HTTP ${response.status}`);
    const bytes = Buffer.from(await response.arrayBuffer());
    if (!bytes.length) throw new Error('Empty export');
    const file = join(root, filename);
    await writeFile(file, bytes);
    return file;
  };
  const waitExport = async (kind, started, events) => {
    if (!started?.out) throw new Error('Export did not return an output path');
    const deadline = Date.now() + JOB_TIMEOUT, samples = [];
    while (Date.now() < deadline) {
      const state = await api(kind === 'wav' ? `${projectPath()}/export-audio` : projectPath());
      const running = kind === 'wav' ? state.running : state.export?.running;
      samples.push({ at: new Date().toISOString(), running });
      await save(`${kind}-poll.json`, { started, samples });
      const failure = events.findLast((event) => event.done && event.ok === false);
      if (failure) throw new Error(failure.label || `${kind} export failed`);
      if (!running) return download(started.out, `export.${kind}`);
      await sleep(750);
    }
    throw new Error(`${kind} export exceeded ${JOB_TIMEOUT / 1000}s; runner app logs contain job errors.`);
  };
  const runExport = async (kind, body) => {
    lastExport = null;
    const watch = await watchJobs();
    let started;
    try {
      started = await api(`${projectPath()}/${kind === 'wav' ? 'export-audio' : 'export'}`, body);
      lastExport = { started, events: watch.events };
      await save(`${kind}-start.json`, started);
      const file = await waitExport(kind, started, watch.events);
      return { started, file };
    } catch (error) {
      error.details = await failedJobEvidence(started, watch.events);
      await save(`${kind}-failure.json`, error.details);
      throw error;
    } finally { await watch.close(); }
  };
  try {
    toolsReady = await stage('export tools', async () => {
      const versions = {};
      for (const [name, bin] of [['ffmpeg', ffmpeg], ['ffprobe', ffprobe]]) {
        versions[name] = (await command(`${name}-version`, bin, ['-version'], 10_000)).split('\n')[0];
      }
      return { binaries: { ffmpeg, ffprobe }, versions, platform: process.platform };
    });
    const made = await stage('synthetic camera fixture', async () => {
      fixture = join(root, 'synthetic_webcam.mov');
      // Match ordinary H.264 camera media; missing libx264 is reported as a fixture failure.
      await command('fixture-create', ffmpeg, ['-y', '-v', 'error', '-nostdin',
        '-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=30',
        '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000',
        '-t', String(SECONDS), '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:a', 'pcm_s16le', fixture]);
      const data = await probe('fixture-probe', fixture);
      duration(data);
      if (!data.streams.some((s) => s.codec_type === 'video') || !data.streams.some((s) => s.codec_type === 'audio')) throw new Error('Fixture lacks video or audio');
      return { file: fixture, probe: data };
    }, toolsReady);
    const imported = await stage('synthetic media import', async () => {
      const created = await api('/api/projects', { name: `CI exports ${Date.now()}`, type: 'tutorial' });
      if (!created?.id) throw new Error('Project creation returned no id');
      project = created.id;
      const response = await fetch(new URL(`${projectPath()}/take-upload?name=synthetic_webcam.mov`, base), {
        method: 'POST', signal: AbortSignal.timeout(20_000), headers: { 'X-Studio': '1', 'Content-Type': 'application/octet-stream' },
        body: await readFile(fixture),
      });
      const text = await response.text();
      await save('import-response.txt', text);
      if (!response.ok) throw new Error(`Import HTTP ${response.status}: ${text.slice(0, 1500)}`);
      view = await api(projectPath());
      await save('import-project.json', view);
      if (view.canvas?.cam !== 'synthetic_webcam.mov' || !view.export?.duration || !view.export?.audio) throw new Error('App did not discover imported camera/audio/duration');
      return { project, camera: view.canvas.cam, duration: view.export.duration, sourceDimensions: view.export.dims };
    }, made);
    await stage('WAV export', async () => {
      const { started, file } = await runExport('wav', { format: 'wav', useCut: false, contents: 'mix' });
      const data = await probe('wav-probe', file);
      duration(data);
      if (!data.streams.some((s) => s.codec_name === 'pcm_s24le' && Number(s.sample_rate) === 48000)) throw new Error('WAV is not 24-bit PCM at 48 kHz');
      return { output: started.out, file, probe: data };
    }, imported);
    await stage('MP4 export', async () => {
      // Runtime-only app import: never imports a server module or changes application code.
      const { normalize, compose } = await import(pathToFileURL(join(resolve(repo), 'web', 'layout.js')).href);
      const layout = normalize({ ...view.layout, preset: 'camera',
        bg: { kind: 'night' }, cam: { ...view.layout.cam, border: 'none', shadow: false } }, 'tutorial');
      const scene = compose(layout, view.export.dims), pngs = { base: solidPng(scene.W, scene.H, [23, 23, 26, 255]) };
      for (const [i, layer] of scene.layers.entries()) pngs[`mask${i}`] = solidPng(layer.box.w, layer.box.h, [255, 255, 255, 255]);
      const { started, file } = await runExport('mp4', { layout, useCut: false, blocks: false, pngs });
      const data = await probe('mp4-probe', file);
      duration(data);
      if (!data.streams.some((s) => s.codec_name === 'h264')) throw new Error('MP4 video is not H.264');
      if (!data.streams.some((s) => s.codec_name === 'aac')) throw new Error('MP4 audio is not AAC');
      return { output: started.out, file, probe: data };
    }, imported); // Deliberately runs on Windows too; product errors must remain visible.
  } catch (error) {
    await note('export helper', 'fail', { message: error.message, stack: error.stack });
  }
  const summary = { project, results, ok: results.length >= 5 && results.every((r) => r.status === 'pass' || r.status === 'info') };
  await save('export-results.json', summary);
  return summary;
}
