// Export is always full quality, from the originals in source/: a 720p playback copy in work/ is never an input, in
// either playback mode, and the size the export works from is the original's. Real FFmpeg, disposable media.
// Run: node --test test/export-originals.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { deflateSync } from 'node:zlib';

const put = (p, data) => { mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, data); };
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
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', head), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}
const dataUrl = (w, h, rgba) => `data:image/png;base64,${png(w, h, rgba).toString('base64')}`;

test('export reads the originals in source/, never the 720p playback copy, in both playback modes', { timeout: 180000 }, async (t) => {
  const ffmpeg = process.env.TEST_FFMPEG || 'ffmpeg', ffprobe = process.env.TEST_FFPROBE || 'ffprobe';
  try { execFileSync(ffmpeg, ['-version'], { stdio: 'pipe' }); execFileSync(ffprobe, ['-version'], { stdio: 'pipe' }); }
  catch (e) { if (e.code === 'ENOENT') { t.skip('FFmpeg and ffprobe are required for this media test'); return; } throw e; }
  const root = mkdtempSync(join(tmpdir(), 'vo-export-originals-'));
  const oldLocal = process.env.STUDIO_LOCAL_DIR;
  process.env.STUDIO_LOCAL_DIR = join(root, 'local');
  put(join(root, 'local/settings.json'), JSON.stringify({ studio: join(root, 'studio'), ffmpeg, ffprobe }));
  t.after(() => { if (oldLocal === undefined) delete process.env.STUDIO_LOCAL_DIR; else process.env.STUDIO_LOCAL_DIR = oldLocal; rmSync(root, { recursive: true, force: true }); });
  const run = (args) => execFileSync(ffmpeg, ['-v', 'error', '-y', ...args], { stdio: 'pipe', timeout: 60000, maxBuffer: 8e6 });
  const { startExport, exportInfo } = await import('../server/export.mjs');
  const { proxyName } = await import('../server/studio.mjs');
  const { playSource } = await import('../server/playback.mjs');
  const { normalize, compose } = await import('../web/layout.js');
  const TAKE = 'fixture_webcam.mp4';
  // The original: 640x360, red then blue at 1 s. The decoy copy: 160x90, green all through.
  const original = join(root, 'original.mp4'), decoy = join(root, 'decoy.mp4');
  run(['-f', 'lavfi', '-i', "color=c=red:s=640x360:r=30,drawbox=x=0:y=0:w=iw:h=ih:color=blue:t=fill:enable='gte(t,1)'", '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000',
    '-t', '2', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-movflags', '+faststart', original]);
  run(['-f', 'lavfi', '-i', 'color=c=0x00ff00:s=160x90:r=30', '-f', 'lavfi', '-i', 'sine=frequency=880:sample_rate=48000', '-t', '2', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', decoy]);
  const layout = normalize({ preset: 'camera', aspect: '16:9', cam: { border: 'none', shadow: false } }, 'tutorial');
  const scene = compose(layout, { cam: [640, 360], files: {} });
  const base = dataUrl(scene.W, scene.H, [23, 23, 26, 255]);
  const pngs = { base, bgOnly: base, ...Object.fromEntries(scene.layers.map((ly, i) => [`mask${i}`, dataUrl(ly.box.w, ly.box.h, [255, 255, 255, 255])])) };
  const color = (file, time) => [...run(['-ss', String(time), '-i', file, '-frames:v', '1', '-vf', 'format=rgb24,crop=1:1:960:540', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'])];

  for (const mode of ['originals', 'optimise']) {
    const id = `export-${mode}`, dir = join(root, 'studio/projects', id);
    put(join(dir, 'project.json'), JSON.stringify({ type: 'tutorial', activeTake: 'fixture', layout, playback: mode }));
    put(join(dir, 'source', TAKE), readFileSync(original));
    put(join(dir, proxyName(TAKE)), readFileSync(decoy));
    if (mode === 'optimise') assert.equal(playSource(dir, TAKE).src, proxyName(TAKE), 'the editor plays the copy');
    assert.deepEqual(exportInfo(id, dir).dims.cam, [640, 360], 'the export sizes from the original');
    const started = await new Promise((done, fail) => {
      const timer = setTimeout(() => fail(new Error('export timed out')), 120000);
      let s;
      try { s = startExport(id, dir, { layout, pngs }, (e) => { if (e.t === 'job' && e.done) { clearTimeout(timer); e.ok ? done(s) : fail(new Error(e.label)); } }); }
      catch (e) { clearTimeout(timer); fail(e); }
    });
    const job = JSON.parse(readFileSync(join(dir, started.job, 'job.json'), 'utf8'));
    const cmds = job.commands?.map((x) => x.ffmpeg) || (Array.isArray(job.ffmpeg?.[0]) ? job.ffmpeg : [job.ffmpeg]);
    const inputs = cmds.flatMap((args) => args.flatMap((a, i) => (args[i - 1] === '-i' ? [String(a).replace(/\\/g, '/')] : [])));
    assert.ok(inputs.some((a) => a.endsWith(`source/${TAKE}`)), `${mode}: the original is an input (${inputs.join(', ')})`);
    assert.ok(!inputs.some((a) => /proxy_/.test(a)), `${mode}: no playback copy is an input`);
    const out = join(dir, started.out);
    const [r, g, b] = color(out, 0.25), [r2, , b2] = color(out, 1.25);
    assert.ok(r > 200 && g < 60 && b < 60, `${mode}: red from the original, not the green copy (${r},${g},${b})`);
    assert.ok(b2 > 200 && r2 < 60, `${mode}: blue after 1 s (${r2},${b2})`);
  }
});
