// Settings → Appearance: how Video Octopus itself looks (web/looks.css). One of ten looks on <html data-look="…">, plus
// Paper Desk's calmer option (data-calm). Edit Bay is today's look and the default. The video's own look is
// Settings → Look, which this never touches.
//
// The choice lives in settings (appearance.look / appearance.calm, read from /api/status on every page) and is
// cached in localStorage, which the small script at the top of index.html reads before the stylesheet paints, so a
// reload doesn't flash Edit Bay first. Frosted draws a project's picture, blurred, behind everything (--frost-image).
import { api } from './ui.js';

// [id, name, light or dark, one line] in the picker's order; Edit Bay first.
export const LOOKS = [
  ['editbay', 'Edit Bay', 'Light', 'Quiet white panels, the picture on a dark stage'],
  ['night', 'Night Desk', 'Dark', 'Warm charcoal desk, cream grid, the picture as a card'],
  ['paper', 'Paper Desk', 'Light', 'Paper and ink grid, ink outlines, hard shadows'],
  ['frost', 'Frosted', 'Dark', 'Takes the colour of the footage you open'],
  ['swiss', 'Swiss', 'Light', 'White, ink and one red; hairline rules'],
  ['clay', 'Clay', 'Light', 'Soft pastels, round and pillowy'],
  ['atelier', 'Atelier', 'Light', 'Linen and paper, a serif for names'],
  ['control', 'Control room', 'Dark', 'A broadcast desk: amber readouts, levels'],
  ['cinema', 'Cinema', 'Dark', 'Near-black screening room, one gold accent'],
  ['split', 'Magenta & Blue', 'Dark', 'Magenta and blue glows on deep ink'],
];
const IDS = LOOKS.map((l) => l[0]);
const KEY = 'studio.look';
const root = document.documentElement;

let current = { look: 'editbay', calm: false };
const listeners = new Set();
export const onLook = (fn) => (listeners.add(fn), () => listeners.delete(fn));
export const currentLook = () => ({ ...current });

const readCache = () => { try { return JSON.parse(localStorage.getItem(KEY) || 'null') || {}; } catch { return {}; } };
const writeCache = (patch) => { try { localStorage.setItem(KEY, JSON.stringify({ ...readCache(), ...patch })); } catch {} };

// Put a look on the page: the attributes, the cache, the browser's theme colour, Frosted's picture.
export function applyLook(a = {}) {
  const look = IDS.includes(a.look) ? a.look : 'editbay';
  const calm = Boolean(a.calm);
  const changed = look !== current.look || calm !== current.calm || root.dataset.look !== look;
  current = { look, calm };
  root.dataset.look = look;
  if (calm) root.dataset.calm = ''; else delete root.dataset.calm;
  // Edit Bay keeps today's theme colour (the white bar); the others follow their --bg.
  const bg = look === 'editbay' ? '#ffffff' : getComputedStyle(root).getPropertyValue('--bg').trim() || '#ffffff';
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', bg);
  writeCache({ look, calm, bg });
  if (look === 'frost') frost(); else { root.style.removeProperty('--frost-image'); root.style.removeProperty('--frost-dim'); }
  if (changed) for (const fn of listeners) { try { fn(current); } catch {} }
  return current;
}

// ---- Frosted: the open project's thumbnail; on other pages the newest project's; none: the solid ground ----
let frostProject = null;   // the project open now, or null
let newest = null;         // { id, at } of the newest project, looked up once per minute at most
async function newestProject() {
  if (newest && Date.now() - newest.at < 60000) return newest.id;
  try {
    const list = await api('/api/projects');
    const p = (Array.isArray(list) ? list : []).slice().sort((a, b) => (b.updated || 0) - (a.updated || 0))[0];
    newest = { id: p?.id || null, at: Date.now() };
  } catch { newest = { id: null, at: Date.now() }; }
  return newest.id;
}
let frostSeq = 0; // only the newest call puts its picture up (a project opened while the newest one is looked up)
async function frost() {
  const n = ++frostSeq;
  const id = frostProject || await newestProject();
  if (n !== frostSeq || current.look !== 'frost') return;
  if (!id) { root.style.removeProperty('--frost-image'); root.style.removeProperty('--frost-dim'); writeCache({ frost: '', frostDim: '' }); return; }
  const url = `/api/projects/${encodeURIComponent(id)}/thumb`;
  root.style.setProperty('--frost-image', `url("${url}")`);
  const dim = await frostDim(url);
  if (n !== frostSeq || current.look !== 'frost') return;
  root.style.setProperty('--frost-dim', String(dim));
  writeCache({ frost: url, frostDim: dim });
}
// How far to darken the picture so the panels' text keeps 4.5:1: bright footage (a white web page, a sunny shot)
// is dimmed more than the board's 0.75. Measured on the brightest region of the thumbnail, which the 70 px blur
// spreads over the window: the darkened ground stays under about 16 % grey under the top of the veil.
const frostDims = new Map();
async function frostDim(url) {
  if (frostDims.has(url)) return frostDims.get(url);
  let dim = 0.75;
  try {
    const img = new Image(); img.src = url; await img.decode();
    const W = 16, H = 9, c = document.createElement('canvas'); c.width = W; c.height = H;
    const g = c.getContext('2d', { willReadFrequently: true }); g.drawImage(img, 0, 0, W, H);
    const d = g.getImageData(0, 0, W, H).data;
    const L = (x, y) => { const i = (Math.min(H - 1, Math.max(0, y)) * W + Math.min(W - 1, Math.max(0, x))) * 4; return 0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2]; };
    let hi = 0; // the brightest 3 × 3-cell neighbourhood: about what the blur leaves of a bright patch
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      let sum = 0; for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) sum += L(x + dx, y + dy);
      hi = Math.max(hi, sum / 9);
    }
    // ground ≈ dim × brightness × (1 − 0.35 veil); keep it at or under 40 (of 255)
    dim = Math.max(0.22, Math.min(0.75, 40 / (Math.max(1, hi) * 0.65)));
  } catch {}
  dim = Math.round(dim * 100) / 100;
  frostDims.set(url, dim);
  return dim;
}
// The router says which project is open (null on the other pages).
export function lookProject(id) {
  frostProject = id || null;
  if (current.look === 'frost') frost();
}

// ---- The Cut Editor in the Cut tab follows the look ----
// The Cut tab frames the Cut Editor (the studio's tools/cut-editor, ?theme=studio); it gets the look's colours,
// radii and fonts from here, resolved to plain rgba() so its waveform canvas can use them too: in the frame's address
// at load (#look=, so it paints in the look at once) and in a studio:look message on every change (web/cutpanel.js).
// Edit Bay sends only its id: the Cut Editor then keeps its own light Video Octopus theme, exactly as before.
const CUT_COLOURS = {
  bg: 'var(--bg)', panel: 'var(--panel)', panel2: 'var(--panel-2)', panel3: 'var(--panel-3)', line: 'var(--line)', line2: 'var(--line-2)',
  text: 'var(--text)', text2: 'var(--text-2)', muted: 'var(--muted)', faint: 'var(--faint)', textHi: 'var(--text-hi, var(--text))',
  accent: 'var(--accent)', accentHi: 'var(--accent-hi, var(--accent))', accentInk: 'var(--accent-ink)', accentText: 'var(--accent-text, var(--accent))', accentSoft: 'var(--accent-soft)',
  sel: 'var(--sel)', selSoft: 'var(--sel-soft)', selInk: 'var(--sel-ink, var(--bg))', selText: 'var(--sel-text, var(--text))',
  ok: 'var(--ok)', warn: 'var(--warn)', bad: 'var(--bad)', okInk: 'var(--ok-ink, var(--ok))', warnInk: 'var(--warn-ink, var(--warn))', badInk: 'var(--bad-ink, var(--bad))',
  wave: 'var(--tl-wave)', playhead: 'var(--playhead, var(--accent))', check: 'var(--check, var(--text))', pop: 'var(--pop-bg, var(--panel))',
};
const rgba = (c) => {
  const m = /^rgba?\(([^)]+)\)$/.exec(c) || /^color\(srgb ([^)]+)\)$/.exec(c);
  if (!m) return null;
  const p = m[1].split(/[\s,/]+/).filter(Boolean).map(Number), k = c.startsWith('color(') ? 255 : 1;
  if (p.length < 3 || p.some((x) => !Number.isFinite(x))) return null;
  const [r, g, b] = p.slice(0, 3).map((x) => Math.round(Math.max(0, Math.min(255, x * k))));
  return `rgba(${r}, ${g}, ${b}, ${+(p[3] ?? 1).toFixed(3)})`;
};
// The bundled faces (style.css, looks.css) of the families a stack names, as [family, file, weight, style].
function faces(stacks) {
  const fams = new Set(stacks.flatMap((s) => s.split(',').map((f) => f.trim().replace(/^["']|["']$/g, ''))));
  const out = [];
  for (const sheet of document.styleSheets) {
    let rules; try { rules = sheet.cssRules; } catch { continue; }
    for (const r of rules) {
      if (!(r instanceof CSSFontFaceRule)) continue;
      const fam = r.style.getPropertyValue('font-family').trim().replace(/^["']|["']$/g, '');
      if (!fams.has(fam) || /^Geist( Mono)?$/.test(fam)) continue; // the Cut Editor has Geist already
      const m = /url\(["']?\/fonts\/([a-z0-9-]+\.woff2)["']?\)/i.exec(r.style.getPropertyValue('src'));
      if (m) out.push([fam, m[1], r.style.getPropertyValue('font-weight') || '400', r.style.getPropertyValue('font-style') || 'normal']);
    }
  }
  return out;
}
export function cutLook() {
  if (current.look === 'editbay' || !document.body) return { id: current.look };
  const probe = document.createElement('i');
  probe.style.cssText = 'position:absolute;visibility:hidden;pointer-events:none';
  document.body.append(probe);
  const c = {};
  for (const [k, v] of Object.entries(CUT_COLOURS)) { probe.style.color = v; c[k] = rgba(getComputedStyle(probe).color) || ''; }
  probe.remove();
  const cs = getComputedStyle(root), tok = (k) => cs.getPropertyValue(k).trim();
  const font = tok('--font'), mono = tok('--mono');
  const panelA = Number((/,\s*([\d.]+)\)$/.exec(c.panel) || [])[1] ?? 1);
  return {
    id: current.look, dark: /dark/.test(cs.colorScheme), c, font, mono,
    ctl: tok('--ctl-radius'), card: tok('--panel-radius'),
    clear: panelA < 0.9, // glass panels (Frosted): the Cut Editor lets Video Octopus's ground show through
    f: faces([font, mono]),
  };
}
// What the Cut tab adds to the Cut Editor's address: &look=<id>, and the look itself after # (never sent to a server).
export function cutLookParams() {
  const l = cutLook();
  return `&look=${encodeURIComponent(l.id)}${l.c ? `#look=${encodeURIComponent(JSON.stringify(l))}` : ''}`;
}

// Another Video Octopus tab changed the look: follow it.
window.addEventListener('storage', (e) => {
  if (e.key !== KEY) return;
  const a = readCache();
  if (a.look && (a.look !== current.look || Boolean(a.calm) !== current.calm)) applyLook(a);
});

// Until /api/status answers, the page keeps what index.html's early script set from the cache.
const early = readCache();
if (IDS.includes(early.look)) current = { look: early.look, calm: Boolean(early.calm) };
