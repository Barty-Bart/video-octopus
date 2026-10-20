// Canvas layouts: where the screen, the webcam and any extra layers go. Shared by the browser canvas
// (web/app.js) and the export (server/export.mjs), so the MP4 puts every card on the same pixel as the preview.
// Pure functions, no DOM. Sizes are export pixels; `u` is 1% of the frame width (like CSS cqw).
//
// layout (project.json "layout"):
//   aspect  '16:9' | '9:16'
//   preset  'screen' | 'camera' | 'pip' | 'split' | 'boxed'
//   side    'right' | 'left'          which side the camera takes in split/boxed
//   mirror  'auto' | true | false     auto = mirror the camera when it sits on the left
//   webcam  { x, y, w }               picture-in-picture box: top-left and width as fractions of the frame
//   pad     0–12                      PiP only: the screen as an inset card, this % of the frame width from the edges
//   cam     { shape, zoom, focus, crop, border, borderW, shadow }   camera framing in every layout:
//             shape 'square' | 'rounded' | 'circle' | 'frame'  (PiP box: square, rounded square, circle, or the whole camera frame)
//             zoom  1–4  (1 = the whole height of the camera picture; 2 = half of it, so twice as close)
//             focus { x, y }  the point of the camera picture the crop centres on (0–1, of the whole picture)
//             crop  { t, r, b, l }  edges trimmed off the picture first (fractions of its width/height; at least 10%
//                    of each side stays); zoom and focus then work inside what's left. Missing = the whole picture.
//             border 'none' | 'subtle' | 'white' | 'black' | 'accent' | '#rrggbb'   the card's edge (subtle = the
//                    Night Desk card line; a hex is any colour: a brand colour or Custom…)
//             borderW 1–40   border width in export pixels (both frame sizes have a 1080 px short side)
//             shadow true | false   the soft Night Desk card shadow
//   screen  { crop, zoom, focus, border, borderW, shadow }   the screen recording's framing, the same fields as cam:
//             crop trims its edges (a browser's top bar, the Dock) and its box takes the shape of what's left; zoom and
//             focus fill the box with part of the screen. border/borderW/shadow are its card edge in PiP with an inset
//             (Boxed uses cam's, so the two cards match). Missing = the whole picture, as before.
//   bg      { kind, file, name }      what shows behind the cards (see web/look.js):
//             kind 'night' (still Night Desk) | 'stars' | 'led' (animated backgrounds)
//                  | 'image' | 'video' | 'code' (file in the project's assets/; code = a module drawing f(t))
//   layers  [{ id, file, kind: 'cam'|'screen', x, y, w, shape, zoom, focus, border, borderW, shadow, audio, hidden }]
//             extra videos from other takes (source/<file>), on top, from 0:00, own box like the PiP
//   hidden  ['cam', 'screen']        the canvas take's camera or screen left out (the inspector's eye); a layer has
//             its own hidden: true. Hidden layers are out of the preview and every export; the others stay in place.

export const SIZES = { '16:9': [1920, 1080], '9:16': [1080, 1920] };
export const FPS = 30;

export const PRESETS = {
  screen: 'Screen',
  camera: 'Camera',
  pip: 'Picture-in-picture',
  split: 'Split',
  boxed: 'Boxed',
};
export const SHAPES = { square: 'Square', rounded: 'Rounded', circle: 'Circle', frame: 'Whole frame' };
export const BORDERS = { none: 'None', subtle: 'Subtle', white: 'White', black: 'Black', accent: 'Accent' };
export const BG_KINDS = { night: 'Night Desk', stars: 'Stars', led: 'LED wave', image: 'Image', video: 'Video', code: 'Code' };

// Night Desk: warm charcoal, faint grid, soft-shadow cards.
export const NIGHT = {
  bg: '#17171A',
  grid: 'rgba(240,236,228,0.045)',
  cell: 0.044,                       // grid cell = 4.4% of the frame width
  card: '#232428',
  line: 'rgba(240,236,228,0.24)',
  shadow: 'rgba(0,0,0,0.75)',        // 0 1.6u 3.6u -1u
  white: '#FFFFFF',                  // photo-card border (the default look)
  accent: '#FF5A1F',                 // the default frame accent
};
// The named borders' colours (subtle is NIGHT.line at its own width); any other border is a '#rrggbb' colour.
export const BORDER_COLORS = { white: NIGHT.white, black: '#000000', accent: NIGHT.accent };
// A border as stored: one of BORDERS, or a colour as '#rrggbb' (#rgb is widened, #rrggbbaa loses its alpha);
// anything else is null.
export function borderValue(v) {
  if (typeof v !== 'string') return null;
  if (BORDERS[v]) return v;
  const s = v.trim().toLowerCase();
  if (/^#[0-9a-f]{3}$/.test(s)) return `#${[...s.slice(1)].map((c) => c + c).join('')}`;
  if (/^#[0-9a-f]{6}([0-9a-f]{2})?$/.test(s)) return s.slice(0, 7);
  return null;
}
// The colour a border draws in ('subtle' → the Night Desk line), or null for none.
export const borderColor = (b) => (b === 'none' ? null : b === 'subtle' ? NIGHT.line : BORDER_COLORS[b] || (/^#[0-9a-f]{6}$/i.test(b || '') ? b : null));
// For the page: "White", "Accent", or the colour's hex.
export const borderLabel = (b) => BORDERS[b] || String(b || '').toUpperCase();

const pipWidth = (aspect) => (aspect === '9:16' ? 0.4 : 0.2);
// The PiP box is square (a self box around the head) unless it shows the whole camera frame.
export const boxAspect = (shape, srcAR) => (shape === 'frame' ? srcAR : 1);
// New projects get white photo-card borders (the default look). Layouts saved before borders existed keep the
// subtle Night Desk line they were drawn with.
export const NO_CROP = { t: 0, r: 0, b: 0, l: 0 };
export const DEFAULT_CAM = { shape: 'rounded', zoom: 1, focus: { x: 0.5, y: 0.45 }, crop: NO_CROP, border: 'white', borderW: 8, shadow: true };
// The screen's framing: the whole picture, and the subtle card line + shadow its PiP inset card always had.
export const DEFAULT_SCREEN = { crop: NO_CROP, zoom: 1, focus: { x: 0.5, y: 0.5 }, border: 'subtle', borderW: 8, shadow: true };
// At least this much of the picture stays in each direction when it's cropped.
export const MIN_KEEP = 0.1;
export const DEFAULT_BG = { kind: 'night' };

export function defaultLayout(type) {
  const aspect = type === 'short' || type === 'reel' ? '9:16' : '16:9';
  return {
    aspect,
    preset: aspect === '9:16' ? 'camera' : type === 'faceless' ? 'screen' : 'pip', // a faceless video starts on the screen alone
    side: 'right',
    mirror: 'auto',
    webcam: { ...cornerPos('br', aspect, pipWidth(aspect), 1), w: pipWidth(aspect) },
    pad: 0,
    cam: structuredClone(DEFAULT_CAM),
    screen: structuredClone(DEFAULT_SCREEN),
    bg: { ...DEFAULT_BG },
    layers: [],
  };
}

const num = (v, lo, hi, def) => (v !== null && v !== '' && v !== undefined && Number.isFinite(Number(v)) ? Math.min(hi, Math.max(lo, Number(v))) : def);
// Crop edges as fractions of the picture, each 0–0.9, and at least MIN_KEEP of each direction left.
export function normCrop(c) {
  const k4 = (v) => Math.round(v * 1e4) / 1e4;
  const v = (k) => k4(num(c?.[k], 0, 1 - MIN_KEEP, 0));
  const t = v('t'), l = v('l');
  return { t, r: k4(Math.min(v('r'), 1 - MIN_KEEP - l)), b: k4(Math.min(v('b'), 1 - MIN_KEEP - t)), l };
}
const framing = (c, def = DEFAULT_CAM) => ({
  shape: SHAPES[c?.shape] ? c.shape : def.shape,
  zoom: num(c?.zoom, 1, 4, def.zoom),
  focus: { x: num(c?.focus?.x, 0, 1, def.focus.x), y: num(c?.focus?.y, 0, 1, def.focus.y) },
  crop: normCrop(c?.crop),
  // A framing saved before borders existed (it has a shape but no border) keeps its subtle line.
  border: borderValue(c?.border) || (c?.shape ? 'subtle' : def.border),
  borderW: num(c?.borderW, 1, 40, def.borderW),
  shadow: typeof c?.shadow === 'boolean' ? c.shadow : def.shadow,
});
const screenFraming = (s) => {
  const { shape, ...f } = framing({ shape: 'frame', ...(s && typeof s === 'object' ? s : {}), border: s?.border || DEFAULT_SCREEN.border }, DEFAULT_SCREEN);
  return f;
};
// A background file must be a plain path inside the project's assets/.
const assetPath = (f) => typeof f === 'string' && /^assets\/[^/\\]+$/.test(f) && !f.includes('..');
export function normalizeBg(b) {
  if (!b || typeof b !== 'object' || !BG_KINDS[b.kind]) return { ...DEFAULT_BG };
  if (['image', 'video', 'code'].includes(b.kind)) {
    if (!assetPath(b.file)) return { ...DEFAULT_BG };
    return { kind: b.kind, file: b.file, ...(typeof b.name === 'string' && b.name ? { name: b.name.slice(0, 60) } : {}) };
  }
  return { kind: b.kind };
}
// Backgrounds that change over time; the export renders them frame by frame (server/backgrounds.mjs).
export const animatedBg = (b) => ['stars', 'led', 'code', 'video'].includes(b?.kind);

// Clean up a layout from project.json, the browser or Claude. Older projects have { webcam, mirror } (M1)
// or a top-level focus (M2).
export function normalize(l, type) {
  l = l && typeof l === 'object' ? l : {};
  const d = defaultLayout(type);
  const aspect = SIZES[l.aspect] ? l.aspect : d.aspect;
  const w = l.webcam || {};
  const sameAspect = aspect === d.aspect;
  const cam = framing(l.cam || (l.focus ? { focus: l.focus } : null));
  const migrated = !l.cam; // M1/M2 layouts sized the PiP for the whole camera frame; the self box is smaller
  return {
    aspect,
    preset: PRESETS[l.preset] ? l.preset : l.webcam ? 'pip' : d.preset,
    side: l.side === 'left' ? 'left' : 'right',
    mirror: [true, false, 'auto'].includes(l.mirror) ? l.mirror : 'auto',
    webcam: {
      x: num(w.x, 0, 1, sameAspect ? d.webcam.x : 0.7),
      y: num(w.y, 0, 1, sameAspect ? d.webcam.y : 0.7),
      w: migrated ? pipWidth(aspect) : num(w.w, 0.05, 0.95, pipWidth(aspect)),
    },
    pad: num(l.pad, 0, 12, 0),
    cam,
    screen: screenFraming(l.screen),
    bg: normalizeBg(l.bg),
    hidden: (Array.isArray(l.hidden) ? l.hidden : []).filter((x, i, a) => (x === 'cam' || x === 'screen') && a.indexOf(x) === i),
    layers: (Array.isArray(l.layers) ? l.layers : []).filter((x) => x && typeof x.file === 'string' && !/[/\\]|^\./.test(x.file)).slice(0, 8)
      .map((x, i) => ({
        id: /^[\w-]{1,40}$/.test(x.id || '') ? x.id : `L${i + 1}`,
        file: x.file,
        kind: x.kind === 'screen' ? 'screen' : 'cam',
        x: num(x.x, 0, 1, 0.05), y: num(x.y, 0, 1, 0.05), w: num(x.w, 0.05, 1, 0.3),
        ...framing(x, x.kind === 'screen' ? { ...DEFAULT_CAM, shape: 'frame', border: 'subtle' } : DEFAULT_CAM),
        audio: Boolean(x.audio),
        ...(x.hidden ? { hidden: true } : {}),
      })),
  };
}

// Top-left of a box of width w (fraction of the frame) and aspect boxAR tucked into a corner (tl, tr, bl, br).
export function cornerPos(corner, aspect, w, boxAR) {
  const [W, H] = SIZES[aspect];
  const m = 2.5 * (W / 100);
  const hFrac = (w * W) / boxAR / H;
  return {
    x: corner[1] === 'l' ? m / W : 1 - w - m / W,
    y: corner[0] === 't' ? m / H : 1 - hFrac - m / H,
  };
}

// A new layout with the given preset/aspect/corner/side/shape applied.
export function withPreset(layout, change, dims) {
  const l = structuredClone(layout);
  const camAR = croppedAR(dims?.cam ? dims.cam[0] / dims.cam[1] : 16 / 9, l.cam?.crop);
  const pipAR = () => boxAspect(l.cam.shape, camAR);
  if (change.aspect && change.aspect !== l.aspect) {
    l.aspect = change.aspect;
    l.webcam.w = pipWidth(l.aspect);
    Object.assign(l.webcam, cornerPos('br', l.aspect, l.webcam.w, pipAR()));
  }
  if (change.shape) l.cam.shape = change.shape;
  if (change.preset) l.preset = change.preset;
  if (change.corner) { l.preset = 'pip'; Object.assign(l.webcam, cornerPos(change.corner, l.aspect, l.webcam.w, pipAR())); }
  if (change.side) l.side = change.side;
  return l;
}

// Where a new take's files go when it's added as a layer: the camera as a self box in the top-right corner,
// a screen as a card on the left.
export function newLayers(layout, files, dims) {
  const [W] = SIZES[layout.aspect];
  return files.map((f, i) => {
    const kind = /_screen\./i.test(f) ? 'screen' : 'cam';
    const ar = dims?.[f] ? dims[f][0] / dims[f][1] : 16 / 9;
    const w = kind === 'cam' ? pipWidth(layout.aspect) : layout.aspect === '9:16' ? 0.8 : 0.45;
    const shape = kind === 'cam' ? 'rounded' : 'frame';
    const pos = kind === 'cam' ? cornerPos('tr', layout.aspect, w, boxAspect(shape, ar)) : { x: 2.5 * (W / 100) / W, y: 0.08 };
    const edge = kind === 'cam' ? { border: layout.cam?.border || DEFAULT_CAM.border, borderW: layout.cam?.borderW || DEFAULT_CAM.borderW, shadow: layout.cam?.shadow ?? true }
      : { border: 'subtle', borderW: DEFAULT_CAM.borderW, shadow: true };
    return { id: `L${Date.now().toString(36)}${i}`, file: f, kind, ...pos, w, shape, zoom: 1, focus: { ...DEFAULT_CAM.focus }, ...edge, audio: false };
  });
}

const R = Math.round;
const box = (x, y, w, h) => ({ x: R(x), y: R(y), w: R(x + w) - R(x), h: R(y + h) - R(y) });

// The largest box with the source's aspect that fits inside a region, centred.
function contain(ar, r) {
  const w = Math.min(r.w, r.h * ar), h = w / ar;
  return box(r.x + (r.w - w) / 2, r.y + (r.h - h) / 2, w, h);
}
// The part of the source (as fractions) shown in a box of aspect `bAR`: it fills the box (cover), is
// `zoom` times closer, and is centred on `focus` as far as the picture allows.
export function cropFor(ar, bAR, focus = DEFAULT_CAM.focus, zoom = 1) {
  let w = 1, h = 1;
  if (ar > bAR) w = bAR / ar; else h = ar / bAR;
  w /= zoom; h /= zoom;
  const clamp = (v, hi) => Math.min(hi, Math.max(0, v));
  return { x: clamp(focus.x - w / 2, 1 - w), y: clamp(focus.y - h / 2, 1 - h), w, h };
}
// What's left of the picture after a crop, as a region of it (fractions), and that region's aspect.
export const cropRegion = (c) => { const k = c || NO_CROP; return { x: k.l, y: k.t, w: 1 - k.l - k.r, h: 1 - k.t - k.b }; };
export const croppedAR = (ar, c) => { const r = cropRegion(c); return (ar * r.w) / r.h; };
// cropFor inside a crop region: the region fills the box (cover), zoom and focus work inside it (focus stays a point
// of the whole picture), and the result is in fractions of the whole picture again, which is what ffmpeg's crop and
// the canvas's drawImage take.
export function cropIn(ar, reg, bAR, focus, zoom) {
  const c = cropFor((ar * reg.w) / reg.h, bAR, { x: (focus.x - reg.x) / reg.w, y: (focus.y - reg.y) / reg.h }, zoom);
  return { x: reg.x + c.x * reg.w, y: reg.y + c.y * reg.h, w: c.w * reg.w, h: c.h * reg.h };
}

// Everything the canvas and the export draw: frame size and the video layers, bottom to top.
// dims = { screen: [w, h] | null, cam: [w, h] | null, files: { <source file>: [w, h] } } (source pixels).
// Each layer: { ref, role: 'screen'|'cam'|'layer', file (layers only), kind, box, crop, radius, border, borderColor,
//               shadow, mirror, movable (drag/resize like a PiP), framed (has a camera crop to reframe/zoom),
//               card (sits on the background as a card, so its border and shadow can be set) }
// The scene also says whether any background shows (bgVisible) and which one (bg).
export function compose(layout, dims) {
  const L = layout;
  const [W, H] = SIZES[L.aspect];
  const u = W / 100;
  const screenAR = dims.screen ? dims.screen[0] / dims.screen[1] : null;
  const camAR = dims.cam ? dims.cam[0] / dims.cam[1] : null;
  let preset = L.preset;
  if (!camAR && preset !== 'screen') preset = 'screen';
  if (!screenAR && preset !== 'camera') preset = 'camera';
  if (!screenAR && !camAR) preset = 'audio'; // a mic-only take (or sound-only block): no picture, just the background
  const cam = L.cam || DEFAULT_CAM;
  // The screen's and the camera's crops: the screen's box is laid out for what's left of it (sAR), and zoom/focus
  // work inside that region (cropIn). The camera fills its box, so only a PiP box in the camera's own shape changes.
  const scr = L.screen || DEFAULT_SCREEN;
  const sReg = cropRegion(scr.crop), cReg = cropRegion(cam.crop);
  const sAR = screenAR && croppedAR(screenAR, scr.crop);

  const full = { x: 0, y: 0, w: W, h: H };
  const px = Math.min(W, H) / 1080; // border widths are export pixels at a 1080 px short side
  // A card's edge from a framing (the camera's, the screen's or a layer's): none, the subtle Night Desk line, or a
  // colour (white, black, accent, a brand colour or a custom one) at its width.
  const edge = (f, big) => {
    const b = f?.border || 'subtle';
    if (b === 'none') return { border: 0, borderColor: null };
    if (b === 'subtle') return { border: Math.max(1, R((big ? 0.12 : 0.3) * u)), borderColor: NIGHT.line };
    return { border: Math.max(1, R((f.borderW || DEFAULT_CAM.borderW) * px)), borderColor: borderColor(b) || NIGHT.white };
  };
  const card = (big, f = null) => ({ radius: R((big ? 1.2 : 1.6) * u), ...edge(f, big), shadow: f ? f.shadow !== false : true, card: true });
  const flat = { radius: 0, border: 0, shadow: false };
  // framed: the picture can be zoomed, reframed and cropped (region = what the crop leaves, in source fractions).
  const screenAt = (b, style) => ({ ref: 'screen', role: 'screen', box: b, crop: cropIn(screenAR, sReg, b.w / b.h, scr.focus, scr.zoom), region: sReg, framed: true, ...style });
  const screenIn = (r, style = flat) => screenAt(contain(sAR, r), style);
  const camIn = (b, style = flat) => ({ ref: 'cam', role: 'cam', box: b, crop: cropIn(camAR, cReg, b.w / b.h, cam.focus, cam.zoom), region: cReg, framed: true, ...style });
  const vertical = L.aspect === '9:16';
  const flip = L.side === 'left';
  // A PiP-style box (the PiP camera and every extra layer): square or the source's shape, rounded or a circle.
  const floating = (pos, ar, f, kind) => {
    const reg = cropRegion(f.crop);
    const bAR = boxAspect(f.shape, croppedAR(ar, f.crop));
    const w = pos.w * W, h = w / bAR;
    const b = box(Math.min(W - w, Math.max(0, pos.x * W)), Math.min(H - h, Math.max(0, pos.y * H)), w, h);
    const style = card(kind === 'screen', f);
    const radius = f.shape === 'circle' ? Math.ceil(b.w / 2) : f.shape === 'square' ? 0 : style.radius;
    return { box: b, crop: cropIn(ar, reg, b.w / b.h, f.focus, f.zoom), region: reg, ...style, radius, movable: true, framed: true };
  };
  let layers = [];

  if (!screenAR && !camAR) layers = [];
  else if (preset === 'screen') layers = [screenIn(full)];
  else if (preset === 'camera') layers = [camIn(box(0, 0, W, H))];
  else if (preset === 'pip') {
    // pad > 0: the screen is an inset card with the background around it.
    const p = (L.pad || 0) * u;
    const screen = p > 0 ? screenIn(box(p, p, W - 2 * p, H - 2 * p), card(true, scr)) : screenIn(full);
    layers = [screen, { ref: 'cam', role: 'cam', ...floating(L.webcam, camAR, cam, 'cam') }];
  }
  else if (preset === 'split') {
    // Full-bleed: screen two thirds, camera one third (9:16: screen on top, camera below).
    let sr, cr;
    if (vertical) { const k = R(H * 0.42); sr = { x: 0, y: 0, w: W, h: k }; cr = box(0, k, W, H - k); }
    else { const k = R(W * 2 / 3); sr = { x: 0, y: 0, w: k, h: H }; cr = box(k, 0, W - k, H); }
    if (flip) {
      if (vertical) { cr = box(0, 0, W, H - sr.h); sr = { x: 0, y: H - sr.h, w: W, h: sr.h }; }
      else { cr = box(0, 0, W - sr.w, H); sr = { x: W - sr.w, y: 0, w: sr.w, h: H }; }
    }
    layers = [screenIn(sr), camIn(cr)];
  } else if (preset === 'boxed') {
    // Boxed: screen card on two thirds, a tall camera card on the right third; both cards share
    // the same top and bottom edge and sit the same distance from the frame edge (9:16 stacks them).
    const gap = 2.5 * u;
    if (!vertical) {
      let sw = 61 * u, h = sw / sAR;
      if (h > 0.8 * H) { h = 0.8 * H; sw = h * sAR; }
      const cw = 28.5 * u, x0 = (W - (sw + gap + cw)) / 2, y = (H - h) / 2;
      const sx = flip ? x0 + cw + gap : x0, cx = flip ? x0 : x0 + sw + gap;
      // The two cards match: the screen card takes the camera card's border and shadow.
      layers = [screenAt(box(sx, y, sw, h), card(true, cam)), camIn(box(cx, y, cw, h), card(false, cam))];
    } else {
      const m = 4 * u, cw = W - 2 * m, total = 0.8 * H, y0 = (H - total) / 2;
      const sh = Math.min(cw / sAR, 0.45 * H), sw = sh * sAR, ch = total - sh - gap;
      const sy = flip ? y0 + ch + gap : y0, cy = flip ? y0 : y0 + sh + gap;
      layers = [screenAt(box((W - sw) / 2, sy, sw, sh), card(true, cam)), camIn(box(m, cy, cw, ch), card(false, cam))];
    }
  }
  // Extra layers from other takes, on top in list order.
  for (const x of L.layers || []) {
    const d = dims.files?.[x.file];
    if (!d) continue;
    layers.push({ ref: `layer:${x.id}`, role: 'layer', file: x.file, kind: x.kind, ...floating(x, d[0] / d[1], x, x.kind) });
  }
  // Mirror a camera that sits on the left, so the creator looks into the screen.
  for (const ly of layers) {
    const isCam = ly.role === 'cam' || (ly.role === 'layer' && ly.kind === 'cam');
    const left = ly.box.x + ly.box.w / 2 < W / 2 - 1;
    ly.mirror = isCam && (ly.role === 'cam' && L.mirror !== 'auto' ? L.mirror === true : preset !== 'camera' || ly.role === 'layer' ? left : false);
  }
  // Hidden layers (the inspector's eye) are left out; the rest keep their places.
  const off = new Set(L.hidden || []);
  for (const x of L.layers || []) if (x.hidden) off.add(`layer:${x.id}`);
  if (off.size) layers = layers.filter((ly) => !off.has(ly.ref));
  return { W, H, u, preset, layers, bg: L.bg || DEFAULT_BG, bgVisible: showsBackground(W, H, layers) };
}

// Does any of the background show? Samples a grid of points; a point counts as covered when it is inside a
// box and not in one of its rounded corners.
function showsBackground(W, H, layers) {
  const inside = (x, y, ly) => {
    const { x: bx, y: by, w, h } = ly.box, r = Math.min(ly.radius || 0, w / 2, h / 2);
    if (x < bx || y < by || x > bx + w || y > by + h) return false;
    const cx = Math.min(Math.max(x, bx + r), bx + w - r), cy = Math.min(Math.max(y, by + r), by + h - r);
    return (x - cx) ** 2 + (y - cy) ** 2 <= r * r + 0.5;
  };
  for (let j = 0; j <= 24; j++) for (let i = 0; i <= 40; i++) {
    const x = Math.min(W - 0.5, (i / 40) * W + 0.25), y = Math.min(H - 0.5, (j / 24) * H + 0.25);
    if (!layers.some((ly) => inside(x, y, ly))) return true;
  }
  return false;
}

// The locked cut snapped to whole frames, so picture and sound are cut at the same instants.
export function snapSegments(segments, duration, fps = FPS) {
  const out = [];
  for (const s of segments || []) {
    let a = Math.round(Math.max(0, Number(s[0])) * fps), b = Math.round(Math.min(duration || Infinity, Number(s[1])) * fps);
    if (!(b > a)) continue;
    const last = out[out.length - 1];
    if (last && a <= last[1]) last[1] = Math.max(last[1], b);
    else out.push([a, b]);
  }
  return out.map(([a, b]) => [a / fps, b / fps]);
}

// =====================================================================================================================
// Shots, transitions and zooms: the look over time. Pure functions, shared by the canvas preview
// (every frame) and the export (server/export.mjs), so the preview and the MP4 can't disagree. The files and their
// edits are in web/shots.js (data, ops) and server/shots.mjs (reading, writing, routes).
//
// TIME. Shot starts and zoom times (a, b, c, d) are seconds of the canvas take ("source seconds"): the same seconds as
// the words (work/tr/words.json), the blocks' take ranges and the locked cut's segments_sec, and the same clock as the
// canvas preview (it plays the take and skips what the cut removes). "Played time" is the locked cut's own timeline
// (the kept parts back to back, in take order): what the export renders and what's on screen. cutMap() maps both ways.
// transitionAt and zoomAt take an optional { cut: segments }: with it, transition lengths, ramps, "shrink to fit" and
// break clipping are measured in played time, so a 0.4 s crossfade lasts 0.4 s on screen even when the cut removed
// material around the break. Without it, played time = source time (no cut, or the whole take).
//
// shots   the shots doc { v: 1, shots: [...] } or its array, sorted by start (web/shots.js normalizeShots). A shot runs
//         from its start to the next shot's start (the last one to the end); the first one starts at 0.
//         shot = { id, start, word, name?, look? (partial layout), in? { type, dur, dir? }, by?, status?, section? }
// zooms   the zooms doc { v: 2, items: [...] } or its array (web/shots.js normalizeZooms).
//         zoom = { id, target 'camera'|'screen', a, b, c, d, box? { x, y, w, h }, amount?, speed? }
// base    the video's own layout (normalize(project.json layout)): the look of every shot without its own changes.

export const LOOK_KEYS = ['preset', 'side', 'mirror', 'webcam', 'pad', 'cam', 'screen', 'hidden'];
export const TRANSITIONS = { cut: 'Cut', fade: 'Crossfade', slide: 'Slide', zoom: 'Zoom' };
export const TRANSITION_DUR = { fade: 0.4, slide: 0.5, zoom: 0.5 }; // defaults; any length 0.2–1.5 s
export const TRANSITION_MIN = 0.2, TRANSITION_MAX = 1.5;
export const SLIDE_DIRS = ['left', 'right', 'up'];
export const ZOOM_SPEEDS = { smooth: 'Smooth', even: 'Even', snap: 'Snap' };
export const ZOOM_TARGETS = { camera: 'Camera', screen: 'Screen' };
export const ZOOM_ROLE = { camera: 'cam', screen: 'screen' }; // a zoom's target → the compose() layer it moves
export const MIN_SHOT = 0.5;      // seconds of played time
export const SNAP_RAMP = 0.1;     // a snap zoom moves in (and out) in this long, whatever its ramps say
export const DEFAULT_PUNCH = 1.1; // a zoom with neither a box nor an amount
// What each preset shows: hiding one of these in a shot makes the layout fall back (lookFallback).
export const NEEDS = { camera: ['cam'], screen: ['screen'], pip: ['cam', 'screen'], split: ['cam', 'screen'], boxed: ['cam', 'screen'] };

const isNum = (v) => v !== null && v !== '' && v !== undefined && typeof v !== 'boolean' && Number.isFinite(Number(v));
const clamp01 = (u) => Math.min(1, Math.max(0, u));

// normalizeLook(look) → a clean partial layout, or null when it changes nothing.
// Only LOOK_KEYS: the background, the aspect, the list of extra layers and the sound stay whole-video. Objects are
// partial too: cam { shape, zoom, focus, crop, border, borderW, shadow }, screen { zoom, focus, crop, border, borderW,
// shadow }, webcam { x, y, w }; focus needs both x and y, crop is one value (all four edges, normCrop). hidden is the
// whole list of what's left out in this shot: 'cam', 'screen' and extra layers as 'layer:<id>'.
export function normalizeLook(look) {
  if (!look || typeof look !== 'object' || Array.isArray(look)) return null;
  const out = {};
  if (PRESETS[look.preset]) out.preset = look.preset;
  if (look.side === 'left' || look.side === 'right') out.side = look.side;
  if ([true, false, 'auto'].includes(look.mirror)) out.mirror = look.mirror;
  if (isNum(look.pad)) out.pad = num(look.pad, 0, 12, 0);
  const w = look.webcam;
  if (w && typeof w === 'object') {
    const o = {};
    for (const [k, lo, hi] of [['x', 0, 1], ['y', 0, 1], ['w', 0.05, 0.95]]) if (isNum(w[k])) o[k] = num(w[k], lo, hi, 0);
    if (Object.keys(o).length) out.webcam = o;
  }
  for (const k of ['cam', 'screen']) {
    const f = look[k];
    if (!f || typeof f !== 'object' || Array.isArray(f)) continue;
    const o = {};
    if (k === 'cam' && SHAPES[f.shape]) o.shape = f.shape;
    if (isNum(f.zoom)) o.zoom = num(f.zoom, 1, 4, 1);
    if (f.focus && isNum(f.focus.x) && isNum(f.focus.y)) o.focus = { x: num(f.focus.x, 0, 1, 0.5), y: num(f.focus.y, 0, 1, 0.5) };
    if (f.crop && typeof f.crop === 'object') o.crop = normCrop(f.crop);
    if (borderValue(f.border)) o.border = borderValue(f.border);
    if (isNum(f.borderW)) o.borderW = num(f.borderW, 1, 40, DEFAULT_CAM.borderW);
    if (typeof f.shadow === 'boolean') o.shadow = f.shadow;
    if (Object.keys(o).length) out[k] = o;
  }
  if (Array.isArray(look.hidden)) out.hidden = look.hidden.filter((x, i, a) => (x === 'cam' || x === 'screen' || /^layer:[\w-]{1,40}$/.test(x)) && a.indexOf(x) === i);
  return Object.keys(out).length ? out : null;
}

// The properties a look changes, as paths ('preset', 'cam.zoom', 'hidden', …): the inspector's accent dots, and
// what "Apply to all shots" moves into the base.
export function lookKeys(look) {
  const out = [];
  for (const [k, v] of Object.entries(look || {})) {
    if (v && typeof v === 'object' && !Array.isArray(v) && ['cam', 'screen', 'webcam'].includes(k)) for (const f of Object.keys(v)) out.push(`${k}.${f}`);
    else out.push(k);
  }
  return out;
}

// mergeLook(base, look) → a full layout: the base with the look on top (cam, screen and webcam by field; hidden
// replaces the whole list and sets each extra layer's own hidden flag). No fallback (effectiveLook adds it).
export function mergeLook(base, look) {
  const l = structuredClone(base);
  if (!look) return l;
  for (const k of ['preset', 'side', 'mirror', 'pad']) if (look[k] !== undefined) l[k] = look[k];
  for (const k of ['webcam', 'cam', 'screen']) if (look[k]) l[k] = { ...(l[k] || {}), ...structuredClone(look[k]) };
  if (Array.isArray(look.hidden)) {
    l.hidden = look.hidden.filter((x) => x === 'cam' || x === 'screen');
    l.layers = (l.layers || []).map((x) => { const y = { ...x }; if (look.hidden.includes(`layer:${x.id}`)) y.hidden = true; else delete y.hidden; return y; });
  }
  return l;
}

// lookFallback(base, look) → null, or { from, to, hidden } when the shot hides a source its layout needs.
// Only a source the shot itself hides (hidden here but not in the base) counts, so the whole video looks as it always
// did: camera hidden → Screen (PiP, Camera, Split, Boxed); screen hidden → Camera. Both hidden: just the background.
export function lookFallback(base, look) {
  if (!look) return null;
  const l = mergeLook(base, look);
  const was = new Set(base?.hidden || []), off = new Set(l.hidden || []);
  const gone = ['cam', 'screen'].filter((x) => off.has(x) && !was.has(x) && (NEEDS[l.preset] || []).includes(x));
  if (!gone.length || (off.has('cam') && off.has('screen'))) return null;
  const to = off.has('cam') ? 'screen' : 'camera';
  return to === l.preset ? null : { from: l.preset, to, hidden: gone[0] };
}

// effectiveLook(base, look) → the full layout a shot shows: mergeLook plus the fallback preset.
export function effectiveLook(base, look) {
  const l = mergeLook(base, look);
  const fb = lookFallback(base, look);
  if (fb) l.preset = fb.to;
  return l;
}

const shotList = (shots) => {
  const list = Array.isArray(shots) ? shots : Array.isArray(shots?.shots) ? shots.shots : [];
  for (let i = 1; i < list.length; i++) if (list[i].start < list[i - 1].start) return [...list].sort((a, b) => a.start - b.start);
  return list;
};

// shotAt(t, shots) → { shot, index, count, start, end } for source second t (end: the next shot's start, or Infinity
// for the last one), or null when there are no shots. A time before the first shot counts as the first shot.
export function shotAt(t, shots) {
  const list = shotList(shots);
  if (!list.length) return null;
  let i = 0;
  while (i + 1 < list.length && list[i + 1].start <= t) i++;
  return { shot: list[i], index: i, count: list.length, start: list[i].start, end: i + 1 < list.length ? list[i + 1].start : Infinity };
}

// lookAt(t, base, shots) → the full layout at source second t: the base, that shot's look on top, and the fallback
// when the shot hid something its layout needs. Pass it straight to compose().
export const lookAt = (t, base, shots) => effectiveLook(base, shotAt(t, shots)?.shot.look || null);

// ---- the cut: source seconds ⇄ played seconds ----
// cutMap(segments) → { toCut(src), toSource(played), identity, length }. A moment the cut removes lands on the next
// kept one (toCut). segments: the locked cut's [[start, end], …] in source seconds (null/empty: no cut, identity).
// The map is cached per segments array, so pass a fresh array when the cut changes (don't edit one in place).
const maps = new WeakMap();
export function cutMap(segments) {
  if (segments && typeof segments === 'object' && maps.has(segments)) return maps.get(segments);
  const segs = [...(segments || [])].sort((a, b) => a[0] - b[0]);
  let acc = 0;
  const parts = segs.map(([a, b]) => { const p = { a, b, c: acc }; acc += b - a; return p; });
  const m = !parts.length ? { toSource: (t) => t, toCut: (t) => t, identity: true, length: Infinity } : {
    toSource(t) { for (const p of parts) if (t < p.c + (p.b - p.a)) return p.a + Math.max(0, t - p.c); return parts.at(-1).b; },
    toCut(s) { for (const p of parts) { if (s < p.a) return p.c; if (s < p.b) return p.c + s - p.a; } return acc; },
    identity: false, length: acc,
  };
  if (segments && typeof segments === 'object') maps.set(segments, m);
  return m;
}
// Source second → played second (no cut: the same).
export const playedAt = (t, cut) => (cut?.length ? cutMap(cut).toCut(t) : t);

// ---- transitions ----
// transitionsOf(shots, { cut, duration }) → every transition, in order:
//   [{ index (the incoming shot's index), id, fromId, type 'fade'|'slide'|'zoom', dir ('left'|'right'|'up' for a
//      slide, else null), at (the break, played seconds), dur (seconds, after shrinking), start, end (played) }]
// A transition belongs to the shot it brings in (shot.in) and is centred on the break; when either shot is shorter
// (in played time) than the transition, it shrinks to the shorter shot's length. Cut, or a shot with no played time
// left: no transition. duration: the take's length in source seconds (the last shot's end); unknown = no limit.
export function transitionsOf(shots, { cut = null, duration = Infinity } = {}) {
  const list = shotList(shots), P = (t) => playedAt(t, cut);
  const at = list.map((s) => P(s.start));
  const end = Number.isFinite(duration) ? P(duration) : Infinity;
  const len = (i) => (i + 1 < list.length ? at[i + 1] : end) - at[i];
  const out = [];
  for (let i = 1; i < list.length; i++) {
    const tr = list[i].in;
    if (!tr || !TRANSITION_DUR[tr.type]) continue;
    const dur = Math.min(num(tr.dur, TRANSITION_MIN, TRANSITION_MAX, TRANSITION_DUR[tr.type]), len(i - 1), len(i));
    if (!(dur > 1e-3)) continue;
    out.push({ index: i, id: list[i].id, fromId: list[i - 1].id, type: tr.type, dir: tr.type === 'slide' ? (SLIDE_DIRS.includes(tr.dir) ? tr.dir : 'left') : null,
      at: at[i], dur, start: at[i] - dur / 2, end: at[i] + dur / 2 });
  }
  return out;
}

// transitionAt(t, base, shots, { cut, duration }) → null outside a transition, else
//   { type, dir, p, dur, at, start, end, index, id, fromId, from, to }
// p: linear progress 0 → 1 across the transition (the drawer eases it if it wants; ffmpeg xfade runs linear).
// from / to: the full layouts (effectiveLook) of the outgoing and incoming shot, ready for compose().
export function transitionAt(t, base, shots, opts = {}) {
  const list = shotList(shots);
  if (list.length < 2) return null;
  const tp = playedAt(t, opts.cut);
  for (const tr of transitionsOf(list, opts)) {
    if (tp < tr.start) break;
    if (tp < tr.end) return { ...tr, p: clamp01((tp - tr.start) / tr.dur), from: effectiveLook(base, list[tr.index - 1].look || null), to: effectiveLook(base, list[tr.index].look || null) };
  }
  return null;
}

// ---- transitions as they draw: ffmpeg's xfade, so the preview paints the frames the export makes ----
// p is transitionAt's linear progress (0 → 1); xfade counts the other way (progress = 1 − p).
// xfadeName(type, dir) → the xfade transition the export uses: fade, slideleft / slideright / slideup, zoomin.
export const xfadeName = (type, dir) => (type === 'slide' ? ({ left: 'slideleft', right: 'slideright', up: 'slideup' })[dir] || 'slideleft' : type === 'zoom' ? 'zoomin' : 'fade');
// slideOffsets(dir, p, W, H) → { from: [x, y], to: [x, y] }: where the outgoing and the incoming pictures go (whole
// pixels, as xfade truncates them). left: both move left, the next comes in from the right; right: from the left; up:
// from below.
export function slideOffsets(dir, p, W, H) {
  const q = 1 - clamp01(p);
  if (dir === 'up') { const s = Math.floor(q * H); return { from: [0, s - H], to: [0, s] }; }
  const s = Math.floor(q * W);
  return dir === 'right' ? { from: [W - s, 0], to: [-s, 0] } : { from: [s - W, 0], to: [s, 0] };
}
// zoominAt(p) → { zf, mix }: xfade's zoomin. The first half pushes into the outgoing picture's centre (it shows zf of
// its width and height, 1 → 0, smoothstep); the second half fades the incoming one in over that (mix: the outgoing
// picture's weight, 1 → 0, smoothstep).
const smoothstep = (e0, e1, x) => { const t = clamp01((x - e0) / (e1 - e0)); return t * t * (3 - 2 * t); };
export function zoominAt(p) { const q = 1 - clamp01(p); return { zf: smoothstep(0.5, 1, q), mix: smoothstep(0, 0.5, q) }; }

// ---- zooms ----
// The ramp curves: smooth = ease in-out (cubic), even = linear, snap = ease-out (cubic) over SNAP_RAMP seconds.
// u: 0 → 1 through the ramp (the out ramp runs it backwards, 1 → 0).
const easeInOut = (u) => (u < 0.5 ? 4 * u * u * u : 1 - Math.pow(-2 * u + 2, 3) / 2);
export function zoomCurve(u, speed) {
  u = clamp01(u);
  return speed === 'even' ? u : speed === 'snap' ? 1 - Math.pow(1 - u, 3) : easeInOut(u);
}
const zoomList = (zooms) => (Array.isArray(zooms) ? zooms : Array.isArray(zooms?.items) ? zooms.items : []);

// zoomTiming(zoom, { shots, cut }) → { a, b, c, d, clipped } in played seconds, or null when nothing of it plays.
// The ramps keep their own lengths (b − a, d − c; snap: SNAP_RAMP) from where the zoom starts and ends on the played
// timeline; a zoom that crosses a shot break ends at the break (clipped: it eases out before it and doesn't carry
// over); ramps longer than what's left shrink in proportion.
export function zoomTiming(z, { shots = null, cut = null } = {}) {
  const P = (t) => playedAt(t, cut);
  const A = P(z.a);
  let D = P(z.d);
  const brk = shots ? shotList(shots).slice(1).map((s) => P(s.start)).find((x) => x > A + 1e-6 && x < D - 1e-6) : undefined;
  if (brk != null) D = brk;
  const len = D - A;
  if (!(len > 1e-6)) return null;
  let ri = z.speed === 'snap' ? SNAP_RAMP : Math.max(0, z.b - z.a), ro = z.speed === 'snap' ? SNAP_RAMP : Math.max(0, z.d - z.c);
  if (ri + ro > len) { const k = len / (ri + ro); ri *= k; ro *= k; }
  return { a: A, b: A + ri, c: D - ro, d: D, clipped: brk != null };
}

// zoomAt(t, target, zooms, { shots, cut }) → null when no zoom on that target is moving or holding at source second t,
// else { id, zoom, target, p, box, amount, under, timing }:
//   p       how far in, 0 (the shot's own framing) → 1 (the zoom's box), after the speed curve
//   box     the zoom's box { x, y, w, h } in fractions of the target's picture after its crop, or null
//   amount  for a zoom without a box: how much closer than the framing (a face punch-in, 1.03–1.15)
//   under   the zoom it starts from when two overlap (the later one wins and moves on from the earlier one's
//           picture), else null
//   timing  zoomTiming's result (played seconds)
// target: 'camera' | 'screen'. Turn it into a crop with zoomedCrop().
export function zoomAt(t, target, zooms, opts = {}) {
  const tp = playedAt(t, opts.cut);
  const live = [];
  zoomList(zooms).forEach((z, k) => {
    if ((z.target || 'camera') !== target) return;
    const T = zoomTiming(z, opts);
    if (T && tp >= T.a && tp < T.d) live.push({ z, T, k });
  });
  if (!live.length) return null;
  live.sort((x, y) => x.T.a - y.T.a || x.k - y.k);
  let state = null;
  for (const { z, T } of live) {
    const u = tp < T.b ? (tp - T.a) / Math.max(1e-6, T.b - T.a) : tp < T.c ? 1 : (T.d - tp) / Math.max(1e-6, T.d - T.c);
    state = { id: z.id, zoom: z, target, p: zoomCurve(u, z.speed), box: z.box || null, amount: z.box ? null : num(z.amount, 1, 4, DEFAULT_PUNCH), under: state, timing: T };
  }
  return state;
}

// A zoom box (fractions of the region the crop leaves) as a crop of the whole picture (fractions) with the shape of the
// target's box on the frame (bAR = its width / height), so nothing stretches: the short side grows around the box's
// centre, and it stays inside the region (smaller if it has to).
export function boxCrop(box, ar, reg, bAR) {
  let w = box.w * reg.w, h = box.h * reg.h;
  const cx = reg.x + (box.x + box.w / 2) * reg.w, cy = reg.y + (box.y + box.h / 2) * reg.h;
  if ((w / h) * ar < bAR) w = (h * bAR) / ar; else h = (w * ar) / bAR;
  const k = Math.min(1, reg.w / w, reg.h / h);
  w *= k; h *= k;
  return { x: Math.min(reg.x + reg.w - w, Math.max(reg.x, cx - w / 2)), y: Math.min(reg.y + reg.h - h, Math.max(reg.y, cy - h / 2)), w, h };
}
// The same box back in fractions of the region: what a zoom stores once it has the frame's shape.
export function fitZoomBox(box, ar, reg, bAR) {
  const c = boxCrop(box, ar, reg, bAR), r4 = (v) => Math.round(v * 1e4) / 1e4;
  return { x: r4((c.x - reg.x) / reg.w), y: r4((c.y - reg.y) / reg.h), w: r4(c.w / reg.w), h: r4(c.h / reg.h) };
}
// Between two crops of the same shape: a zoom about a fixed point whose scale changes linearly with e (0 = A, 1 = B).
//   k = 1 + (A.w / B.w − 1)·e,  w = A.w / k,  f = (A.w − w) / (A.w − B.w)  (f = e when the sizes match),
//   crop = A + (B − A)·f  for x, y, w and h.
export function lerpCrop(A, B, e) {
  if (!(e > 0)) return A;
  if (e >= 1) return B;
  const k = 1 + (A.w / B.w - 1) * e, w = A.w / k;
  const f = Math.abs(A.w - B.w) > 1e-9 ? (A.w - w) / (A.w - B.w) : e;
  return { x: A.x + (B.x - A.x) * f, y: A.y + (B.y - A.y) * f, w: A.w + (B.w - A.w) * f, h: A.h + (B.h - A.h) * f };
}
// zoomedCrop(layout, ly, z, dims) → the crop (fractions of the whole source picture, like ly.crop) to draw a compose()
// layer with while zoom state z (zoomAt) is on it. layout: the look at that moment (lookAt); ly: its 'cam' or 'screen'
// layer; dims: compose()'s dims. A box zooms into that part of the picture; an amount zooms the shot's own framing
// that much closer on its focus (a face punch-in). No zoom, or another kind of layer: ly.crop as it is.
export function zoomedCrop(layout, ly, z, dims) {
  if (!z || !ly?.crop || (ly.role !== 'cam' && ly.role !== 'screen')) return ly?.crop;
  const d = dims?.[ly.role];
  if (!d) return ly.crop;
  const ar = d[0] / d[1], bAR = ly.box.w / ly.box.h;
  const fr = (ly.role === 'cam' ? layout?.cam : layout?.screen) || (ly.role === 'cam' ? DEFAULT_CAM : DEFAULT_SCREEN);
  const reg = ly.region || cropRegion(fr.crop);
  const to = z.box ? boxCrop(z.box, ar, reg, bAR) : cropIn(ar, reg, bAR, fr.focus || { x: 0.5, y: 0.5 }, Math.min(16, (fr.zoom || 1) * (z.amount || DEFAULT_PUNCH)));
  const from = z.under ? zoomedCrop(layout, ly, z.under, dims) : ly.crop;
  return lerpCrop(from, to, z.p);
}
