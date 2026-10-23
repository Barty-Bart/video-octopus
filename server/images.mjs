// Images for Packaging: reading what an image model returned, measuring it, and cutting a contact sheet into cards.
// The image provider today is Codex (the creator's ChatGPT plan, through `codex app-server`). Everything Video Octopus
// assumes about Codex's image item is in codexImage() below, so a protocol change is fixed in one place. Cutting and
// resizing use the studio's FFmpeg. No network.
import { execFile } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { studioTool } from './util.mjs';

// The contact sheet: one image, 6 numbered concepts in 3 columns × 2 rows, each a 16:9 thumbnail.
export const SHEET_GRID = { cols: 3, rows: 2 };
// A refined thumbnail: YouTube's recommended size.
export const THUMB_SIZE = { width: 1280, height: 720 };

// ---- Codex's image item ----
// Checked against the app-server protocol of codex-cli 0.162.0 (`codex app-server generate-json-schema` /
// `generate-ts`, ImageGenerationThreadItem; feature `image_generation` stable):
//   { type: 'imageGeneration', id: string, status: string, revisedPrompt: string | null, result: string,
//     savedPath?: absolute path | null, transparentBackground?: boolean | null,
//     failure?: { type: 'usageLimitExceeded', limitId: string, resetsAt: number | null } | null }
// Assumptions, to confirm with one real (paid) turn before relying on them:
//   - savedPath, when present, is a finished image file Codex wrote (it is copied into the file store at once).
//   - result is base64 image bytes when there is no savedPath (used only if it decodes to a PNG, JPEG or WebP).
//   - status strings are not documented; anything with an image counts as done, and "failed" without one as failed.
//   - resetsAt is a Unix time in seconds (a value that already looks like milliseconds is kept as it is).
export function codexImage(item) {
  const it = item && typeof item === 'object' ? item : {};
  const out = { id: String(it.id || ''), status: String(it.status || ''), revisedPrompt: typeof it.revisedPrompt === 'string' ? it.revisedPrompt : null,
    path: null, bytes: null, failure: null,
    // What arrived, without the bytes: kept on the sheet or card so the first real run shows the actual shape.
    wire: { status: String(it.status || ''), savedPath: typeof it.savedPath === 'string', resultChars: typeof it.result === 'string' ? it.result.length : null,
      transparentBackground: it.transparentBackground ?? null } };
  if (it.failure && typeof it.failure === 'object') {
    if (it.failure.type === 'usageLimitExceeded') {
      const resetsAt = resetTime(it.failure.resetsAt);
      out.failure = { kind: 'usage-limit', limitId: String(it.failure.limitId || ''), resetsAt, message: usageLimitText(resetsAt) };
    } else out.failure = { kind: 'failed', message: 'Codex could not make the image.' };
    return out;
  }
  if (typeof it.savedPath === 'string' && existsSync(it.savedPath) && lstatSync(it.savedPath).isFile()) out.path = it.savedPath;
  else if (typeof it.result === 'string' && it.result.length > 64) {
    const bytes = Buffer.from(it.result.replace(/^data:image\/[a-z]+;base64,/, ''), 'base64');
    if (imageType(bytes)) out.bytes = bytes;
  }
  if (!out.path && !out.bytes) out.failure = { kind: 'failed', message: /fail|error|cancel/i.test(out.status) ? 'Codex could not make the image.' : 'Codex finished without an image file.' };
  return out;
}
// A turn-level error that means the plan's limit is used up (TurnError.codexErrorInfo).
export const isUsageLimitError = (error) => error?.codexErrorInfo === 'usageLimitExceeded' || error?.codexErrorInfo?.usageLimitExceeded !== undefined;

function resetTime(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return null;
  return n < 1e12 ? n * 1000 : n;
}
export function usageLimitText(resetsAt) {
  if (!resetsAt) return 'Image limit reached on your ChatGPT plan. Try again later.';
  const at = new Date(resetsAt);
  const sameDay = at.toDateString() === new Date().toDateString();
  const when = at.toLocaleString(undefined, sameDay ? { hour: '2-digit', minute: '2-digit' } : { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
  return `Image limit reached on your ChatGPT plan. It resets ${sameDay ? 'at' : 'on'} ${when}.`;
}

// ---- measuring ----
export function imageType(bytes) {
  if (!bytes || bytes.length < 12) return null;
  if (bytes[0] === 0x89 && bytes.toString('ascii', 1, 4) === 'PNG') return 'png';
  if (bytes[0] === 0xff && bytes[1] === 0xd8) return 'jpeg';
  if (bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP') return 'webp';
  if (bytes.toString('ascii', 0, 3) === 'GIF') return 'gif';
  return null;
}
export const extensionFor = (bytes) => ({ png: '.png', jpeg: '.jpg', webp: '.webp', gif: '.gif' })[imageType(bytes)] || '';

// Width and height from the file header (PNG, JPEG, WebP, GIF), without decoding the picture. null when unknown.
export function imageSize(input) {
  const bytes = Buffer.isBuffer(input) ? input : readFileSync(input);
  const type = imageType(bytes);
  if (type === 'png' && bytes.length >= 24) return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
  if (type === 'gif') return { width: bytes.readUInt16LE(6), height: bytes.readUInt16LE(8) };
  if (type === 'webp') {
    const chunk = bytes.toString('ascii', 12, 16);
    if (chunk === 'VP8X' && bytes.length >= 30) return { width: 1 + bytes.readUIntLE(24, 3), height: 1 + bytes.readUIntLE(27, 3) };
    if (chunk === 'VP8 ' && bytes.length >= 30) return { width: bytes.readUInt16LE(26) & 0x3fff, height: bytes.readUInt16LE(28) & 0x3fff };
    if (chunk === 'VP8L' && bytes.length >= 25) {
      const b = bytes.readUInt32LE(21);
      return { width: 1 + (b & 0x3fff), height: 1 + ((b >> 14) & 0x3fff) };
    }
    return null;
  }
  if (type === 'jpeg') {
    for (let i = 2; i + 9 < bytes.length;) {
      if (bytes[i] !== 0xff) { i++; continue; }
      const marker = bytes[i + 1];
      if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { i += 2; continue; }
      const length = bytes.readUInt16BE(i + 2);
      if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) return { height: bytes.readUInt16BE(i + 5), width: bytes.readUInt16BE(i + 7) };
      i += 2 + length;
    }
  }
  return null;
}

// ---- cutting a contact sheet ----
// The cards of a sheet by its known grid: each cell, inset a little to drop the gutters and numbers at the edges, then
// the largest centred 16:9 box inside it. Boxes are whole pixels: [{ n, x, y, w, h }], n = 1…6 left to right, top to
// bottom (the numbers the prompt asks the model to draw).
export function sheetBoxes({ width, height }, { cols, rows } = SHEET_GRID, inset = 0.03) {
  if (!(width > 0 && height > 0)) throw new Error('The sheet has no size.');
  const boxes = [];
  const cellW = width / cols, cellH = height / rows;
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const innerW = cellW * (1 - 2 * inset), innerH = cellH * (1 - 2 * inset);
      const w = Math.min(innerW, innerH * 16 / 9), h = w * 9 / 16;
      const x = c * cellW + (cellW - w) / 2, y = r * cellH + (cellH - h) / 2;
      boxes.push({ n: r * cols + c + 1, x: Math.round(x), y: Math.round(y), w: Math.max(2, Math.floor(w / 2) * 2), h: Math.max(2, Math.floor(h / 2) * 2) });
    }
  }
  return boxes;
}

const ffmpeg = (args) => new Promise((done, fail) => {
  execFile(studioTool('ffmpeg'), ['-hide_banner', '-loglevel', 'error', '-y', ...args], { timeout: 60000 }, (err, stdout, stderr) => {
    if (err) fail(new Error(err.code === 'ENOENT' ? 'Cutting images needs FFmpeg (Setup → Tools installs it).' : `FFmpeg could not cut the image: ${String(stderr || err.message).trim().split('\n').slice(-1)[0]}`));
    else done();
  });
});

// One PNG per box, written to outPaths[i].
export async function cutBoxes(src, boxes, outPaths) {
  for (const [i, b] of boxes.entries()) {
    mkdirSync(dirname(outPaths[i]), { recursive: true });
    await ffmpeg(['-i', src, '-vf', `crop=${b.w}:${b.h}:${b.x}:${b.y}`, '-frames:v', '1', outPaths[i]]);
  }
}

// Fill 1280 × 720 exactly (scale to cover, centre crop): a refined thumbnail is always YouTube's size.
export async function fitThumbnail(src, out, { width, height } = THUMB_SIZE) {
  mkdirSync(dirname(out), { recursive: true });
  await ffmpeg(['-i', src, '-vf', `scale=${width}:${height}:force_original_aspect_ratio=increase,crop=${width}:${height}`, '-frames:v', '1', out]);
}
