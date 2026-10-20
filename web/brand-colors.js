// A logo's main colours, in the browser: sample the picture (see-through pixels left out, and a plain background
// colour round the edge too, like the white of a JPEG logo), cluster what's left with k-means and keep the 3–5
// biggest groups. paletteFromPixels is plain JavaScript (the smoke test runs it in Node); paletteFromFile draws an
// image file onto a small canvas first.

const dist2 = (a, b) => (a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2 + (a[2] - b[2]) ** 2;
export const hex = (c) => `#${c.slice(0, 3).map((v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0')).join('')}`;

// data: RGBA bytes (ImageData.data), w × h. Returns up to `max` colours as "#rrggbb", biggest group first.
export function paletteFromPixels(data, w, h, { max = 5, min = 3 } = {}) {
  const at = (x, y) => { const i = (y * w + x) * 4; return [data[i], data[i + 1], data[i + 2], data[i + 3]]; };
  // The edge: if it's mostly one opaque colour, that's a background, not the brand.
  const ring = [];
  for (let x = 0; x < w; x++) ring.push(at(x, 0), at(x, h - 1));
  for (let y = 1; y < h - 1; y++) ring.push(at(0, y), at(w - 1, y));
  let bg = null;
  const solid = ring.filter((p) => p[3] >= 200);
  if (solid.length > ring.length * 0.6) {
    const mean = [0, 1, 2].map((k) => solid.reduce((s, p) => s + p[k], 0) / solid.length);
    if (solid.filter((p) => dist2(p, mean) < 24 ** 2).length > solid.length * 0.8) bg = mean;
  }
  // Buckets of 5 bits per channel, with counts: fast, and steady from run to run.
  const step = Math.max(1, Math.floor(Math.sqrt((w * h) / 40000)));
  const buckets = new Map();
  let total = 0;
  for (let y = 0; y < h; y += step) for (let x = 0; x < w; x += step) {
    const p = at(x, y);
    if (p[3] < 160 || (bg && dist2(p, bg) < 30 ** 2)) continue;
    const key = ((p[0] >> 3) << 10) | ((p[1] >> 3) << 5) | (p[2] >> 3);
    const b = buckets.get(key);
    if (b) { b.n++; b.s[0] += p[0]; b.s[1] += p[1]; b.s[2] += p[2]; } else buckets.set(key, { n: 1, s: [p[0], p[1], p[2]] });
    total++;
  }
  if (!total) return bg ? [hex(bg)] : [];
  const pts = [...buckets.values()].map((b) => ({ c: b.s.map((v) => v / b.n), n: b.n }));
  // k-means++ without chance: start from the biggest bucket, then the one that most needs a centre of its own.
  const k = Math.min(8, pts.length);
  const centres = [pts.reduce((a, b) => (b.n > a.n ? b : a)).c.slice()];
  while (centres.length < k) {
    let best = null, score = -1;
    for (const p of pts) { const d = Math.min(...centres.map((c) => dist2(p.c, c))); const s = d * p.n; if (s > score) { score = s; best = p; } }
    if (!best || score <= 0) break;
    centres.push(best.c.slice());
  }
  let groups = [];
  for (let it = 0; it < 14; it++) {
    groups = centres.map(() => ({ s: [0, 0, 0], n: 0 }));
    for (const p of pts) {
      let bi = 0, bd = Infinity;
      centres.forEach((c, i) => { const d = dist2(p.c, c); if (d < bd) { bd = d; bi = i; } });
      const g = groups[bi]; g.n += p.n; for (let j = 0; j < 3; j++) g.s[j] += p.c[j] * p.n;
    }
    groups.forEach((g, i) => { if (g.n) centres[i] = g.s.map((v) => v / g.n); });
  }
  // Merge groups that look alike, drop the tiny ones (anti-aliased edges), biggest first.
  let list = groups.map((g, i) => ({ c: centres[i], n: g.n })).filter((g) => g.n).sort((a, b) => b.n - a.n);
  const merged = [];
  for (const g of list) {
    const near = merged.find((m) => dist2(m.c, g.c) < 36 ** 2);
    if (near) { near.c = near.c.map((v, j) => (v * near.n + g.c[j] * g.n) / (near.n + g.n)); near.n += g.n; } else merged.push({ ...g });
  }
  list = merged.sort((a, b) => b.n - a.n);
  const big = list.filter((g) => g.n >= total * 0.015);
  const out = (big.length >= Math.min(min, list.length) ? big : list.slice(0, min)).slice(0, max);
  return out.map((g) => hex(g.c));
}

// An image File or Blob (PNG, JPEG, WebP, GIF, SVG) → its main colours. Browser only.
export async function paletteFromFile(file, opts) {
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    img.decoding = 'async';
    img.src = url;
    await img.decode();
    const w0 = img.naturalWidth || 300, h0 = img.naturalHeight || 300;
    const s = Math.min(1, 220 / Math.max(w0, h0));
    const w = Math.max(1, Math.round(w0 * s)), h = Math.max(1, Math.round(h0 * s));
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    const g = c.getContext('2d', { willReadFrequently: true });
    g.drawImage(img, 0, 0, w, h);
    return paletteFromPixels(g.getImageData(0, 0, w, h).data, w, h, opts);
  } finally { URL.revokeObjectURL(url); }
}
