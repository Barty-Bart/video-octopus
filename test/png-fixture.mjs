// A tiny PNG writer for tests (no dependencies): synthetic images such as a 3 × 2 contact sheet with six coloured cells.
import { deflateSync } from 'node:zlib';

const CRC = new Int32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c;
});
function crc32(bytes) {
  let c = -1;
  for (const b of bytes) c = CRC[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}
function chunk(type, data) {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, 'ascii');
  data.copy(out, 8);
  out.writeUInt32BE(crc32(Buffer.concat([Buffer.from(type, 'ascii'), data])), 8 + data.length);
  return out;
}

// pixel(x, y) → [r, g, b]
export function png(width, height, pixel) {
  const raw = Buffer.alloc((width * 3 + 1) * height);
  for (let y = 0; y < height; y++) {
    const row = y * (width * 3 + 1);
    raw[row] = 0;
    for (let x = 0; x < width; x++) {
      const [r, g, b] = pixel(x, y);
      raw[row + 1 + x * 3] = r;
      raw[row + 2 + x * 3] = g;
      raw[row + 3 + x * 3] = b;
    }
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8; // bit depth
  header[9] = 2; // RGB
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', header), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

// Six distinct colours in a 3 × 2 grid with dark gutters, like the contact sheet Packaging asks for.
export const SHEET_COLOURS = [[220, 40, 40], [40, 180, 60], [40, 80, 220], [230, 200, 30], [200, 40, 200], [30, 200, 210]];
export function sheetPng(width = 600, height = 400) {
  const cw = width / 3, ch = height / 2;
  return png(width, height, (x, y) => {
    const cx = x % cw, cy = y % ch;
    if (cx < cw * 0.02 || cx > cw * 0.98 || cy < ch * 0.02 || cy > ch * 0.98) return [10, 10, 10];
    return SHEET_COLOURS[Math.floor(y / ch) * 3 + Math.floor(x / cw)];
  });
}
