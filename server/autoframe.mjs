// Frames the camera around the head and shoulders: finds the face in a few frames of a camera file with
// macOS Vision (tools/face.swift, compiled once into local/bin/face), or on Windows and Linux with OpenCV through the
// studio's Python (tools/face.py, needs opencv-python), and turns it into a crop focus + zoom
// for layout.cam or a camera layer (see web/layout.js). Zoom 1 = the whole height of the camera picture.
import { existsSync, mkdirSync, statSync, rmSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { join } from 'node:path';
import { APP_DIR, LOCAL_DIR, IS_MAC, studioTool, python } from './util.mjs';

const SRC = join(APP_DIR, 'tools', 'face.swift');
const BIN = join(LOCAL_DIR, 'bin', 'face');

const run = (cmd, args) => new Promise((done, fail) => execFile(cmd, args, { timeout: 180000 }, (e, out, err) =>
  (e ? fail(new Error(String(err || e.message).trim().split('\n').pop())) : done(String(out)))));

// [command, args before the images]
async function detector() {
  if (!IS_MAC) return [python(), [join(APP_DIR, 'tools', 'face.py')]];
  if (existsSync(BIN) && statSync(BIN).mtimeMs >= statSync(SRC).mtimeMs) return [BIN, []];
  mkdirSync(join(LOCAL_DIR, 'bin'), { recursive: true });
  await run('xcrun', ['swiftc', '-O', SRC, '-o', BIN]);
  return [BIN, []];
}

const median = (a) => [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)];
const r3 = (v) => Math.round(v * 1000) / 1000;

// file: absolute path of a camera video. Returns { focus, zoom } or null when no face is found.
// shape 'circle': a little tighter, with the face nearer the middle, so the round edge doesn't cut the head.
export async function autoFrame(file, duration, { shape } = {}) {
  const [bin, pre] = await detector();
  const tmp = join(LOCAL_DIR, 'tmp');
  mkdirSync(tmp, { recursive: true });
  const imgs = [];
  for (const [i, f] of [0.2, 0.4, 0.6, 0.8].entries()) {
    const out = join(tmp, `face_${process.pid}_${Date.now()}_${i}.jpg`);
    try {
      await run(studioTool('ffmpeg'), ['-v', 'error', '-y', '-ss', Math.max(0, (duration || 4) * f).toFixed(2), '-i', file, '-frames:v', '1', '-vf', 'scale=640:-2', out]);
      if (existsSync(out)) imgs.push(out);
    } catch {}
  }
  if (!imgs.length) return null;
  let found;
  try { found = JSON.parse(await run(bin, [...pre, ...imgs])); }
  catch (e) {
    // The first time Auto-frame needs Python and it isn't there: say so, and where it's installed (with an OK).
    if (!IS_MAC && /ENOENT|not found|is not recognized/i.test(e.message)) throw new Error('Auto-frame needs Python on this computer, which isn\'t set up yet: Ask Claude (the Video Octopus assistant) to install it, and it asks before each step. Until then, drag inside the camera to frame yourself.');
    if (!IS_MAC && /cv2|No module|face detector/i.test(e.message)) throw new Error('Auto-frame needs OpenCV 4 on this computer (pip install "opencv-python<5" for the Python Video Octopus uses). Until then, drag inside the camera to frame yourself.');
    throw e;
  }
  finally { for (const f of imgs) rmSync(f, { force: true }); }
  const faces = found.map((list) => list.sort((a, b) => b.w * b.h - a.w * a.h)[0]).filter(Boolean);
  if (!faces.length) return null;
  const cx = median(faces.map((f) => f.x + f.w / 2)), cy = median(faces.map((f) => f.y + f.h / 2)), fh = median(faces.map((f) => f.h));
  // Head and shoulders: the crop is ~3.2 face heights tall with the face in its upper part
  // (a circle: ~2.8 face heights, the face just above the middle).
  const round = shape === 'circle';
  const cropH = Math.min(1, Math.max(0.25, fh * (round ? 2.8 : 3.2)));
  return { focus: { x: r3(cx), y: r3(Math.min(1, cy + (round ? 0.06 : 0.1) * cropH)) }, zoom: r3(Math.min(4, Math.max(1, 1 / cropH))) };
}
