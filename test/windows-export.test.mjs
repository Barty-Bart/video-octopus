// Cross-platform export regression. Uses actual FFmpeg and disposable media only.
// Windows argument selection is exercised on every host; non-Windows execution
// verifies the resulting software filtergraphs, not native Windows compatibility.
// Run: node --test test/windows-export.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, copyFileSync, rmSync, existsSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { deflateSync } from 'node:zlib';
import { createHash } from 'node:crypto';

const put = (p, data) => { mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, data); };
const json = (p, data) => put(p, JSON.stringify(data));
const read = (p) => JSON.parse(readFileSync(p, 'utf8'));
const hash = (p) => createHash('sha256').update(readFileSync(p)).digest('hex');
const crcTable = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
function png(w, h, rgba) {
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) for (let c = 0; c < 4; c++) raw[y * (w * 4 + 1) + 1 + x * 4 + c] = rgba[c];
  const chunk = (type, bytes) => {
    const td = Buffer.concat([Buffer.from(type), bytes]), len = Buffer.alloc(4), crc = Buffer.alloc(4);
    len.writeUInt32BE(bytes.length); let c = 0xffffffff;
    for (const b of td) c = crcTable[(c ^ b) & 255] ^ (c >>> 8);
    crc.writeUInt32BE((c ^ 0xffffffff) >>> 0); return Buffer.concat([len, td, crc]);
  };
  const head = Buffer.alloc(13); head.writeUInt32BE(w); head.writeUInt32BE(h, 4); head[8] = 8; head[9] = 6;
  return Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]), chunk('IHDR', head), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}
const dataUrl = (w, h, rgba) => `data:image/png;base64,${png(w, h, rgba).toString('base64')}`;

test('Windows software export arguments produce playable media through every exporter', { timeout: 180000 }, async (t) => {
  const host = process.platform;
  const ffmpeg = process.env.TEST_FFMPEG || 'ffmpeg', ffprobe = process.env.TEST_FFPROBE || 'ffprobe';
  // Absence is an explicit skip, never a green assertion. Installed tools that fail
  // during rendering are failures and are not replaced by mocks or alternate codecs.
  try { execFileSync(ffmpeg, ['-version'], { stdio: 'pipe' }); execFileSync(ffprobe, ['-version'], { stdio: 'pipe' }); }
  catch (e) { if (e.code === 'ENOENT') { t.skip('FFmpeg and ffprobe are required for this media integration test'); return; } throw e; }
  t.diagnostic(`Native host: ${host}; export platform selection: win32; ${String(execFileSync(ffmpeg, ['-version'])).split('\n')[0]}`);
  const root = mkdtempSync(join(tmpdir(), 'octopus-windows-export-'));
  const oldLocal = process.env.STUDIO_LOCAL_DIR, oldFetch = globalThis.fetch;
  process.env.STUDIO_LOCAL_DIR = join(root, 'local');
  json(join(root, 'local/settings.json'), { studio: join(root, 'studio'), ffmpeg, ffprobe });
  globalThis.fetch = () => { throw new Error('No network is allowed in the export fixture'); };
  // This file runs in Node's isolated test child. Only application platform choices
  // are simulated; the executable remains the real host FFmpeg, stated above.
  Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
  t.after(() => {
    Object.defineProperty(process, 'platform', { value: host, configurable: true });
    globalThis.fetch = oldFetch;
    if (oldLocal === undefined) delete process.env.STUDIO_LOCAL_DIR; else process.env.STUDIO_LOCAL_DIR = oldLocal;
    rmSync(root, { recursive: true, force: true });
  });
  const { videoDecodeArgs, h264 } = await import('../server/util.mjs');
  const { startExport, exportInfo } = await import('../server/export.mjs');
  const { startLayersExport } = await import('../server/export-layers.mjs');
  const { shotsPlan } = await import('../server/export-shots.mjs');
  const { sequenceForExport } = await import('../server/blocks.mjs');
  const { normalize, compose } = await import('../web/layout.js');
  const { sceneKey } = await import('../web/exportshots.js');
  const run = (args, options = {}) => execFileSync(ffmpeg, ['-v', 'error', '-y', ...args], { stdio: 'pipe', timeout: 60000, maxBuffer: 8e6, ...options });
  const source = join(root, 'fixture_webcam.mov'), sponsor = join(root, 'sponsor.mov');
  run(['-f', 'lavfi', '-i', "color=c=red:s=320x180:r=30,drawbox=x=0:y=0:w=iw:h=ih:color=blue:t=fill:enable='gte(t,1)'", '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000',
    '-t', '2', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'pcm_s16le', source]);
  run(['-f', 'lavfi', '-i', 'color=c=0x00ff00:s=320x180:r=30', '-f', 'lavfi', '-i', 'sine=frequency=880:sample_rate=48000',
    '-t', '1', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'pcm_s16le', sponsor]);
  const hashes = [hash(source), hash(sponsor)];
  const layout = normalize({ preset: 'camera', aspect: '16:9', cam: { border: 'none', shadow: false } }, 'tutorial');
  const make = (id) => {
    const dir = join(root, 'studio/projects', id);
    json(join(dir, 'project.json'), { type: 'tutorial', activeTake: 'fixture', layout });
    mkdirSync(join(dir, 'source'), { recursive: true });
    copyFileSync(source, join(dir, 'source/fixture_webcam.mov'));
    copyFileSync(sponsor, join(dir, 'source/sponsor.mov'));
    return dir;
  };
  const pngsFor = (scene) => {
    const base = dataUrl(scene.W, scene.H, [23,23,26,255]);
    const p = { base, bgOnly: base };
    scene.layers.forEach((ly, i) => { p[`mask${i}`] = dataUrl(ly.box.w, ly.box.h, [255,255,255,255]); });
    return p;
  };
  const basePngs = pngsFor(compose(layout, { cam: [320,180], files: {} }));
  const waitExport = (start, id, dir, body) => new Promise((done, fail) => {
    const timer = setTimeout(() => fail(new Error(`${id} export timed out`)), 90000);
    let started;
    try { started = start(id, dir, body, (event) => {
      if (event.t !== 'job' || !event.done) return;
      clearTimeout(timer);
      event.ok ? done(started) : fail(new Error(event.label));
    }); } catch (e) { clearTimeout(timer); fail(e); }
  });
  const checkCommands = (job) => {
    const cmds = job.commands?.map((x) => x.ffmpeg) || (Array.isArray(job.ffmpeg?.[0]) ? job.ffmpeg : [job.ffmpeg]);
    assert.ok(cmds.length);
    for (const args of cmds) {
      assert.ok(Array.isArray(args)); assert.ok(!args.includes('-hwaccel'));
      assert.ok(!args.some((x) => String(x).includes('videotoolbox')));
    }
    return cmds;
  };
  const probe = (file) => JSON.parse(String(execFileSync(ffprobe, ['-v','error','-count_frames','-show_entries','stream=codec_type,codec_name,width,height,nb_read_frames:format=duration','-of','json',file], { timeout: 30000 })));
  const playable = (file, seconds, { audio = true, codec = 'h264' } = {}) => {
    const info = probe(file), video = info.streams.find((x) => x.codec_type === 'video');
    assert.equal(video?.codec_name, codec); assert.equal(video.width, 1920); assert.equal(video.height, 1080);
    assert.equal(Number(video.nb_read_frames), Math.round(seconds * 30));
    assert.ok(Math.abs(Number(info.format.duration) - seconds) < 0.1);
    if (audio) assert.equal(info.streams.find((x) => x.codec_type === 'audio')?.codec_name, 'aac');
  };
  const color = (file, time, channel) => {
    const bytes = run(['-ss',String(time),'-i',file,'-frames:v','1','-vf','format=rgb24,crop=1:1:960:540','-f','rawvideo','-pix_fmt','rgb24','-']);
    assert.equal(bytes.length, 3);
    assert.ok(bytes[channel] > 200 && [...bytes].every((v,i) => i === channel || v < 40), `Expected channel ${channel}, got ${[...bytes]}`);
  };

  await t.test('decoder choices are explicit for Mac, Windows and Linux', () => {
    assert.deepEqual(videoDecodeArgs('darwin'), ['-hwaccel','videotoolbox']);
    assert.deepEqual(videoDecodeArgs('win32'), []); assert.deepEqual(videoDecodeArgs('linux'), []);
    assert.ok(h264().includes('libx264')); assert.ok(!h264().includes('h264_videotoolbox'));
  });

  await t.test('the fresh-install two-second 1080p MP4 fixture decodes and encodes in software', async () => {
    const dir = make('plain');
    const started = await waitExport(startExport, 'plain', dir, { layout, pngs: basePngs });
    const cmds = checkCommands(read(join(dir, started.job, 'job.json')));
    assert.equal(cmds.length, 1); assert.ok(cmds[0].includes('libx264'));
    assert.match(cmds[0][cmds[0].indexOf('-filter_complex') + 1], /setpts=PTS-STARTPTS.*alphamerge.*overlay.*format=yuv420p/);
    const out = join(dir, started.out); playable(out, 2); color(out, 0.25, 0); color(out, 1.25, 2);
    assert.equal(existsSync(`${out}.part`), false);
  });

  await t.test('reordered cut blocks and a separate file render in the intended order', async () => {
    const dir = make('sequence');
    json(join(dir, 'work/blocks.json'), { v: 1, marked: true, blocks: [
      { id: 'last', type: 'body', label: 'Last first', order: 1, source: { take: [1,2] } },
      { id: 'file', type: 'sponsor', label: 'File', order: 2, source: { file: 'source/sponsor.mov' } },
      { id: 'first', type: 'body', label: 'First last', order: 3, source: { take: [0,1] } },
    ] });
    const started = await waitExport(startExport, 'sequence', dir, { layout, pngs: { ...basePngs, blocks: { file: basePngs } } });
    assert.ok(checkCommands(read(join(dir, started.job, 'job.json'))).length >= 4);
    const out = join(dir, started.out); playable(out, 3); color(out, 0.25, 2); color(out, 1.25, 1); color(out, 2.25, 0);
  });

  await t.test('shot seeking, a transition and a non-seeked file block use software video inputs', async () => {
    const dir = make('shots');
    json(join(dir, 'work/blocks.json'), { v: 1, marked: true, blocks: [
      { id: 'take', type: 'body', label: 'Take', order: 1, source: { take: [0,2] } },
      { id: 'file', type: 'sponsor', label: 'File', order: 2, source: { file: 'source/sponsor.mov' } },
    ] });
    json(join(dir, 'work/shots.json'), { v: 1, shots: [{ id: 's1', start: 0 }, { id: 's2', start: 1, look: { cam: { zoom: 1.4 } }, in: { type: 'fade', dur: 0.2 } }] });
    const info = exportInfo('shots', dir), seq = sequenceForExport(dir);
    const plan = shotsPlan(dir, { layout, info, seq }); assert.equal(plan.changes, true);
    const looks = {};
    for (const part of plan.parts) for (const r of part.plan?.runs || []) looks[sceneKey(r.scene)] = pngsFor(r.scene);
    const started = await waitExport(startExport, 'shots', dir, { layout, pngs: { ...basePngs, looks, blocks: { file: basePngs } } });
    const job = read(join(dir, started.job, 'job.json')), cmds = checkCommands(job);
    assert.ok(job.pieces?.length >= 4); assert.ok(cmds.some((args) => args.includes('-ss')));
    assert.ok(cmds.some((args) => args.some((s) => String(s).includes('xfade='))));
    const out = join(dir, started.out); playable(out, 3); color(out, 0.25, 0); color(out, 1.75, 2); color(out, 2.25, 1);
  });

  await t.test('layer cards and presenter mattes decode in software and keep alpha output', async () => {
    const dir = make('layers'), mask = png(320,180,[255,255,255,255]);
    for (let i = 0; i < 60; i++) put(join(dir, 'masks', `${String(i).padStart(4,'0')}.png`), mask);
    const started = await waitExport(startLayersExport, 'layers', dir, { layout, pngs: basePngs, graphics: false, matte: true, timeline: false, small: true });
    checkCommands(read(join(dir, started.job, 'job.json')));
    const folder = join(dir, started.out), man = read(join(folder, 'layers.json'));
    const videos = man.video.map((v) => ({ ...v, file: resolve(folder, v.file) }));
    assert.equal(videos.length, 2);
    const camera = videos.find((v) => /camera/i.test(v.layer)), matte = videos.find((v) => /presenter|matte|cut.out/i.test(v.layer));
    assert.ok(camera); assert.ok(matte);
    playable(camera.file, 2, { audio: false }); playable(matte.file, 2, { audio: false, codec: 'prores' });
    color(camera.file, 0.25, 0); color(camera.file, 1.25, 2);
  });

  await t.test('synthetic source media are unchanged', () => { assert.deepEqual([hash(source),hash(sponsor)], hashes); });
});
