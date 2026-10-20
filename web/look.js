// The canvas "look": backgrounds behind the cards, the camera's card edge (border, shadow) and the reframe
// guide. Used by the canvas (web/app.js) and by the headless page that renders animated backgrounds for the
// export (web/bg-render.html, web/bg-worker.js), so the MP4 shows the same frames as the preview.
//
// A background painter is a pure function of time: paint(g, W, H, t) fills the whole W×H frame for second t.
//   night   the still Night Desk (warm charcoal, faint square grid)
//   stars   Night Desk with drifting stars             (core/kit/night-desk-bg.js)
//   led     Night Desk + an LED wave (same kit)
//   image   a picture from the project's assets/, filling the frame (cover)
//   video   a video from assets/, filling the frame, looping (the export loops it with ffmpeg)
//   code    a module in assets/ (made by Claude or kept in the library): export default { name, draw(g, W, H, t) }
// Nothing here touches the DOM at import time, so a worker can import it.
import { NIGHT, BORDERS, borderValue, animatedBg } from './layout.js';

const canvas = (w, h) => {
  if (typeof document === 'undefined') return new OffscreenCanvas(w, h);
  const c = document.createElement('canvas'); c.width = w; c.height = h; return c;
};

// The Night Desk ground: the colour and a 1 px grid line at the top/left of every 4.4%-of-width cell
// (the same grid the CSS draws, and the one the LED dots sit on).
export function paintNight(g, W, H) {
  g.fillStyle = NIGHT.bg; g.fillRect(0, 0, W, H);
  const cell = NIGHT.cell * W;
  g.fillStyle = NIGHT.grid;
  for (let i = 0; i * cell < W; i++) g.fillRect(Math.round(i * cell), 0, 1, H);
  for (let j = 0; j * cell < H; j++) g.fillRect(0, Math.round(j * cell), W, 1);
}
const grounds = new Map();
function ground(W, H) {
  const k = `${W}x${H}`;
  if (!grounds.has(k)) { const c = canvas(W, H); paintNight(c.getContext('2d'), W, H); grounds.set(k, c); }
  return grounds.get(k);
}

// The background kit sets globalThis.NightDesk.
let kit = null;
const nightDesk = () => (kit ||= import('/kit/night-desk-bg.js').then(() => globalThis.NightDesk));

// Cover: the picture fills the frame, centred, cropped on the long side (ffmpeg: scale=increase + crop).
export function drawCover(g, src, sw, sh, W, H) {
  g.fillStyle = NIGHT.bg; g.fillRect(0, 0, W, H);
  if (!sw || !sh) return;
  const s = Math.max(W / sw, H / sh), dw = sw * s, dh = sh * s;
  g.drawImage(src, (W - dw) / 2, (H - dh) / 2, dw, dh);
}

// One frame's time on the export timeline, snapped to the frame that is on screen at t (frame n shows n/fps).
export const frameTime = (t, fps = 30) => Math.floor(t * fps + 1e-6) / fps;

// painterFor(bg, { url }) → { kind, animated, paint(g, W, H, t), sync?(t, playing), dispose?() }
// url(file) turns a project file (assets/…) into a URL this page can load.
export async function painterFor(bg, { url, version = '' } = {}) {
  const kind = bg?.kind || 'night';
  if (kind === 'stars' || kind === 'led') {
    const ND = await nightDesk();
    if (!ND) throw new Error('The Night Desk kit did not load.');
    return {
      kind, animated: true,
      paint(g, W, H, t) {
        g.save();
        ND.draw(g, W, H, t, kind);                           // clears the frame, draws the stars / dots
        g.globalCompositeOperation = 'destination-over';    // ...then the ground goes underneath them
        g.drawImage(ground(W, H), 0, 0);
        g.restore();
      },
    };
  }
  if (kind === 'code') {
    const mod = await import(`${url(bg.file)}${version ? `${url(bg.file).includes('?') ? '&' : '?'}v=${version}` : ''}`);
    const def = mod.default || mod;
    if (typeof def?.draw !== 'function') throw new Error(`${bg.file} has no draw(g, W, H, t).`);
    return {
      kind, animated: true, name: def.name,
      paint(g, W, H, t) {
        g.save(); g.fillStyle = NIGHT.bg; g.fillRect(0, 0, W, H);
        try { def.draw(g, W, H, t); } finally { g.restore(); }
      },
    };
  }
  if (kind === 'image') {
    const src = url(bg.file);
    let img;
    if (typeof document === 'undefined') img = await createImageBitmap(await (await fetch(src)).blob());
    else { img = new Image(); img.decoding = 'async'; img.src = src; await img.decode(); }
    const [w, h] = [img.naturalWidth || img.width, img.naturalHeight || img.height];
    return { kind, animated: false, paint: (g, W, H) => drawCover(g, img, w, h, W, H) };
  }
  if (kind === 'video' && typeof document !== 'undefined') {
    const v = document.createElement('video');
    Object.assign(v, { muted: true, loop: true, playsInline: true, preload: 'auto' });
    v.className = 'hidden-media';
    v.src = url(bg.file);
    document.body.append(v);
    await new Promise((res, rej) => { v.addEventListener('loadeddata', res, { once: true }); v.addEventListener('error', () => rej(new Error(`Can't play ${bg.file}.`)), { once: true }); });
    return {
      kind, animated: true, video: v,
      // The background loops on the export timeline: second t shows t mod its length.
      sync(t, playing) {
        const d = v.duration || 0;
        if (!d) return;
        // +1 ms: t % d can land a hair before a frame's start (6.6 % 4 = 2.5999…), which would show the frame before.
        const want = Math.min(d - 0.001, (t % d) + 0.001);
        if (!playing) { if (!v.paused) v.pause(); if (Math.abs(v.currentTime - want) > 0.02) v.currentTime = want; return; }
        if (Math.abs(v.currentTime - want) > 0.15 && Math.abs(v.currentTime - want) < d - 0.15) v.currentTime = want;
        if (v.paused) v.play().catch(() => {});
      },
      paint: (g, W, H) => drawCover(g, v, v.videoWidth, v.videoHeight, W, H),
      dispose() { v.pause(); v.removeAttribute('src'); v.load(); v.remove(); },
    };
  }
  return { kind: 'night', animated: false, paint: paintNight };
}

export const isAnimated = animatedBg;

// ---------- a card's edge: border colour and width, shadow (the Border section of the inspector) ----------
// The colours: None, Subtle (the Night Desk card line), White, Black, Accent, the studio's brand colours (Settings →
// Look → Brand, the same list the Brand kit edits) and Custom… (a colour picker and a hex field). A layout stores a
// name or the colour's hex (web/layout.js borderValue), so brand colours are plain hexes in it.
const SWATCH = { none: 'transparent', subtle: 'rgba(120,120,120,.35)', white: '#ffffff', black: '#000000', accent: NIGHT.accent };
export const edgeHTML = () => `<div id="edgeBox">
  <div class="edge-sw" id="border" role="radiogroup" aria-label="Border colour"></div>
  <div class="edge-custom" id="borderCustom" hidden><label class="edge-pick" title="Pick any colour"><input type="color" id="borderPick" aria-label="Custom border colour"><span class="vh">Pick a colour</span></label>
    <input class="field num" id="borderHex" maxlength="7" spellcheck="false" autocomplete="off" placeholder="#RRGGBB" aria-label="Border colour as a hex code"></div>
  <label class="slider" id="borderWRow" title="Border width in export pixels"><span>Width</span><input type="range" id="borderW" min="1" max="30" step="1"><span class="val" id="borderWVal">8 px</span></label>
  <div class="row"><span>Shadow</span><label class="toggle"><input type="checkbox" role="switch" id="shadow"><span class="sw" aria-hidden="true"></span><span class="vh">Card shadow</span></label></div>
  <p class="sub" id="edgeNote" hidden>In Boxed the screen card and the camera card match: this changes both.</p></div>`;

// Brand colours as border values (#rrggbb, no repeats).
const brandHexes = (list) => (list || []).map(borderValue).filter((c, i, a) => c && c.startsWith('#') && a.indexOf(c) === i);
// The hex a border draws in, for the colour picker ('subtle' and 'none' have none of their own).
const hexOf = (b) => (b?.startsWith?.('#') ? b : { white: '#ffffff', black: '#000000', accent: NIGHT.accent.toLowerCase() }[b] || '#ffffff');

// Wires the edge controls. frame() = the framing whose edge is edited (the camera, a layer, the screen; in Boxed the
// screen's is the camera's), change(save) = redraw (and save).
export function wireEdge(ins, { frame, change }) {
  const box = ins.querySelector('#edgeBox');
  const set = (v, save = true) => { const f = frame(); if (f && v) { f.border = v; change(save); } };
  box.querySelector('#border').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-b]');
    if (!b) return;
    if (b.dataset.b === 'custom') {
      // Custom…: the picker and the hex field show; the border takes the picker's colour once one is picked.
      box.dataset.custom = '1';
      const c = box.querySelector('#borderCustom');
      c.hidden = false;
      box.querySelector('#borderHex').focus();
      return;
    }
    delete box.dataset.custom;
    set(b.dataset.b);
  });
  const pick = box.querySelector('#borderPick'), hex = box.querySelector('#borderHex');
  pick.oninput = () => { hex.value = pick.value.toUpperCase(); set(pick.value, false); };
  pick.onchange = () => set(pick.value, true);
  // The hex field applies as soon as it holds a whole colour (#rrggbb, #rgb with Enter); leaving it changes nothing more.
  const parse = () => { const t = hex.value.trim(); return borderValue(t.startsWith('#') ? t : `#${t}`); };
  const fromHex = (final) => {
    const v = parse();
    if (!v || !v.startsWith('#')) { if (final) hex.setAttribute('aria-invalid', 'true'); return; }
    hex.removeAttribute('aria-invalid');
    pick.value = v;
    set(v, final);
  };
  hex.oninput = () => { if (/^#?[0-9a-f]{6}$/i.test(hex.value.trim())) fromHex(false); };
  hex.onkeydown = (e) => { if (e.key === 'Enter') { e.preventDefault(); fromHex(true); } if (e.key === 'Escape') { e.stopPropagation(); hex.blur(); } };
  hex.onchange = () => { if (parse()?.startsWith('#')) fromHex(true); };
  const w = box.querySelector('#borderW');
  w.oninput = () => { const f = frame(); if (f) { f.borderW = Number(w.value); change(false); } };
  w.onchange = () => change(true);
  box.querySelector('#shadow').onchange = (e) => { const f = frame(); if (f) { f.shadow = e.target.checked; change(true); } };
}
// f = the framing, it = the layer on the canvas (its card says whether it has an edge), brand = the brand colours.
export function renderEdge(ins, f, it, preset, brand = []) {
  const box = ins.querySelector('#edgeBox');
  const sec = box.closest('section');
  const on = Boolean(f && it?.card);
  (sec || box).hidden = !on;
  if (!on) return;
  const cur = borderValue(f.border) || 'subtle';
  const brands = brandHexes(brand);
  const custom = cur.startsWith('#') && !brands.includes(cur);
  const sw = box.querySelector('#border');
  const sig = JSON.stringify([brands, cur, custom]);
  if (sw.dataset.sig !== sig) {
    sw.dataset.sig = sig;
    const btn = (k, name, c, cls = '') => `<button type="button" role="radio" data-b="${k}" title="${name}" aria-label="${name}" aria-checked="${k === cur || (k === 'custom' && custom)}" class="${k === cur || (k === 'custom' && custom) ? 'on' : ''}${cls}"><i class="sw-dot ${k.startsWith('#') ? 'hex' : k}" style="--c:${c}"></i></button>`;
    sw.innerHTML = Object.entries(BORDERS).map(([k, n]) => btn(k, n, SWATCH[k])).join('')
      + (brands.length ? `<span class="edge-brand" aria-hidden="true">Brand</span>${brands.map((c, i) => btn(c, `Brand colour ${i + 1}: ${c.toUpperCase()}`, c)).join('')}` : '')
      + btn('custom', custom ? `Custom colour: ${cur.toUpperCase()}` : 'Custom colour…', custom ? cur : 'transparent', ' edge-more');
  }
  const pick = box.querySelector('#borderPick'), hex = box.querySelector('#borderHex');
  box.querySelector('#borderCustom').hidden = !(custom || box.dataset.custom);
  if (document.activeElement !== pick) pick.value = hexOf(cur);
  if (document.activeElement !== hex) { hex.value = custom ? cur.toUpperCase() : ''; hex.removeAttribute('aria-invalid'); }
  const w = box.querySelector('#borderW');
  if (document.activeElement !== w) w.value = f.borderW;
  box.querySelector('#borderWVal').textContent = `${f.borderW} px`;
  box.querySelector('#borderWRow').hidden = ['none', 'subtle'].includes(cur);
  box.querySelector('#shadow').checked = f.shadow !== false;
  box.querySelector('#edgeNote').hidden = preset !== 'boxed';
}

// ---------- Reframe: the whole camera picture, faint, around the box, and centre guides inside it ----------
// Drawn under the box itself (ghost) and on top of everything (guides), preview only.
export function drawGhost(g, ly, v, u) {
  if (!v?.videoWidth) return;
  const { x, y, w, h } = ly.box, c = ly.crop;
  const fw = w / c.w, fh = h / c.h;
  const fx = ly.mirror ? x - (1 - c.x - c.w) * fw : x - c.x * fw, fy = y - c.y * fh;
  // Only what the crop leaves can be panned to, so only that shows (the whole picture when there's no crop).
  const reg = ly.region || { x: 0, y: 0, w: 1, h: 1 };
  const rx = ly.mirror ? fx + (1 - reg.x - reg.w) * fw : fx + reg.x * fw, ry = fy + reg.y * fh, rw = reg.w * fw, rh = reg.h * fh;
  g.save();
  g.beginPath(); g.rect(rx, ry, rw, rh); g.clip();
  g.fillStyle = 'rgba(12,12,14,0.62)'; g.fillRect(rx, ry, rw, rh); // a dark veil, so the picture reads over a bright screen
  g.globalAlpha = 0.5;
  if (ly.mirror) { g.translate(fx + fw, fy); g.scale(-1, 1); g.drawImage(v, 0, 0, fw, fh); }
  else g.drawImage(v, fx, fy, fw, fh);
  g.restore();
  g.save();
  g.strokeStyle = 'rgba(255,255,255,0.55)'; g.lineWidth = Math.max(1, u * 0.1); g.setLineDash([u * 0.6, u * 0.45]);
  g.strokeRect(rx, ry, rw, rh);
  g.restore();
}
export function drawGuides(g, ly, u, color) {
  const { x, y, w, h } = ly.box, cx = x + w / 2, cy = y + h / 2;
  g.save();
  g.beginPath();
  if (ly.radius >= w / 2 - 1) g.arc(cx, cy, w / 2, 0, Math.PI * 2); else g.rect(x, y, w, h);
  g.clip();
  g.strokeStyle = 'rgba(255,255,255,0.7)'; g.lineWidth = Math.max(1, u * 0.08);
  g.beginPath(); g.moveTo(cx, y); g.lineTo(cx, y + h); g.moveTo(x, cy); g.lineTo(x + w, cy); g.stroke();
  // eye line: a third of the way down (head and shoulders), dashed
  g.setLineDash([u * 0.4, u * 0.4]); g.strokeStyle = 'rgba(255,255,255,0.45)';
  g.beginPath(); g.moveTo(x, y + h / 3); g.lineTo(x + w, y + h / 3); g.stroke();
  g.setLineDash([]);
  g.fillStyle = color; g.beginPath(); g.arc(cx, cy, u * 0.35, 0, Math.PI * 2); g.fill();
  g.restore();
}

// ---------- Background section of the inspector ----------
// The built-in presets, the library folder, this project's own backgrounds, Upload, Generate…
const PRESETS = [
  { kind: 'night', name: 'Night Desk', note: 'Still Night Desk (the long-form base).' },
  { kind: 'stars', name: 'Stars', note: 'Drifting stars, a shooting star every 4 s.' },
  { kind: 'led', name: 'LED wave', note: 'A slow diagonal wave over the grid dots.' },
];
const same = (a, b) => a?.kind === b?.kind && (a?.file || '') === (b?.file || '');

export function makeBackgroundSection(sec, { id, get, set, api, toast, esc, h }) {
  let list = { library: [], project: [], libraryDir: '' }, sig = '', loading = null, lastLoad = 0;
  const projectUrl = (f) => `/api/projects/${encodeURIComponent(id)}/files/${f.split('/').map(encodeURIComponent).join('/')}`;
  sec.innerHTML = `<h3>Background</h3>
    <div class="bg-grid" id="bgPresets" role="group" aria-label="Built-in backgrounds"></div>
    <div class="bg-sub" id="bgProjectH" hidden>This project</div><div class="bg-grid" id="bgProject"></div>
    <div class="bg-sub" id="bgLibH" hidden>Library</div><div class="bg-grid" id="bgLib"></div>
    <p class="sub bg-note" id="bgNote"></p>
    <div class="two"><button class="btn" id="bgUpload" title="Use an image or a video as the background (copied into this project's assets/)">Upload…</button>
      <button class="btn" id="bgGen" title="Ask Claude to make a background in code and save it to your library">Generate…</button></div>
    <button class="btn ghost wide" id="bgSave" hidden title="Keep this background in your library for other projects">Save to library</button>
    <input type="file" id="bgFile" accept="image/png,image/jpeg,image/webp,video/mp4,video/quicktime,video/webm" hidden>
    <div class="bg-gen" id="bgGenBox" hidden><label class="vh" for="bgPrompt">Describe the background</label>
      <textarea id="bgPrompt" rows="3" placeholder="e.g. slow amber dots drifting left over the dark grid"></textarea>
      <div class="pp-row"><button class="btn ghost small" id="bgGenX">Cancel</button><button class="btn dark small" id="bgGenGo">Ask Claude</button></div></div>`;
  const $ = (s) => sec.querySelector(s);

  // Small moving previews: presets and code backgrounds are painted (animated while hovered).
  function swatch(item) {
    const on = same(item.bg, get().bg);
    const b = h(`<button class="bgs${on ? ' on' : ''}" aria-pressed="${on}" title="${esc(item.name)}"><span class="bgs-pic"></span><span class="bgs-n">${esc(item.name)}</span></button>`);
    const pic = b.querySelector('.bgs-pic');
    if (item.bg.kind === 'image') pic.append(h(`<img alt="" loading="lazy" src="${esc(item.url)}">`));
    else if (item.bg.kind === 'video') {
      const v = h(`<video muted loop playsinline preload="metadata" src="${esc(item.url)}#t=1"></video>`);
      b.onmouseenter = () => v.play().catch(() => {}); b.onmouseleave = () => v.pause();
      pic.append(v);
    } else {
      const c = canvas(384, 216); pic.append(c);
      const g = c.getContext('2d');
      // Stars and LED dots are sized for the full frame, so their swatch is the top-left third of a
      // full-size frame (with the first shooting star in it); a code background shows whole.
      const zoomed = item.bg.kind === 'stars' || item.bg.kind === 'led';
      const big = zoomed ? canvas(1920, 1080) : null;
      painterFor(item.bg, { url: () => item.url, version: item.v }).then((p) => {
        let raf = 0;
        const draw = (t) => {
          if (!big) return p.paint(g, 384, 216, t);
          p.paint(big.getContext('2d'), 1920, 1080, t);
          g.drawImage(big, 0, 0, 640, 360, 0, 0, 384, 216);
        };
        draw(0.5);
        b.onmouseenter = () => { const s = performance.now(); const loop = (now) => { draw(0.5 + (now - s) / 1000); raf = requestAnimationFrame(loop); }; raf = requestAnimationFrame(loop); };
        b.onmouseleave = () => { cancelAnimationFrame(raf); draw(0.5); };
      }).catch(() => { g.fillStyle = NIGHT.bg; g.fillRect(0, 0, 384, 216); });
    }
    b.onclick = () => item.pick();
    return b;
  }

  function render() {
    const cur = get().bg;
    const s = JSON.stringify([cur, list.library.map((x) => x.file + x.v), list.project.map((x) => x.file + x.v)]);
    if (s === sig) return;
    sig = s;
    $('#bgPresets').replaceChildren(...PRESETS.map((p) => swatch({ bg: { kind: p.kind }, name: p.name, pick: () => set({ kind: p.kind }) })));
    const proj = list.project.map((x) => swatch({ ...x, bg: { kind: x.kind, file: x.file }, pick: () => set({ kind: x.kind, file: x.file, name: x.name }) }));
    $('#bgProject').replaceChildren(...proj); $('#bgProjectH').hidden = !proj.length;
    const lib = list.library.map((x) => swatch({ ...x, bg: { kind: x.kind, file: `library:${x.file}` }, pick: () => useLibrary(x) }));
    $('#bgLib').replaceChildren(...lib); $('#bgLibH').hidden = !lib.length;
    const preset = PRESETS.find((p) => p.kind === cur.kind);
    const mine = list.project.find((x) => x.file === cur.file);
    $('#bgNote').textContent = preset ? preset.note
      : `${mine?.name || cur.name || cur.file} · ${cur.kind === 'code' ? 'drawn in code' : cur.kind}${mine?.inLibrary ? ' · in your library' : ''}`;
    $('#bgSave').hidden = !(cur.file && mine && !mine.inLibrary);
  }

  async function load(force = false) {
    if (loading || (!force && Date.now() - lastLoad < 2000)) return loading;
    loading = api(`/api/projects/${encodeURIComponent(id)}/backgrounds`).then((d) => {
      list = { ...d, project: d.project.map((x) => ({ ...x, url: projectUrl(x.file) })), library: d.library.map((x) => ({ ...x, url: `/api/library/backgrounds/${encodeURIComponent(x.file)}` })) };
      lastLoad = Date.now();
    }).catch(() => {}).finally(() => { loading = null; render(); });
    return loading;
  }

  async function useLibrary(x) {
    try {
      const r = await api(`/api/projects/${encodeURIComponent(id)}/background`, { op: 'use', file: x.file });
      await load(true); set(r.bg);
    } catch (e) { toast(e.message); }
  }

  $('#bgUpload').onclick = () => $('#bgFile').click();
  $('#bgFile').onchange = async (e) => {
    const f = e.target.files[0];
    e.target.value = '';
    if (!f) return;
    const btn = $('#bgUpload');
    btn.disabled = true; btn.textContent = 'Copying…';
    try {
      const r = await fetch(`/api/projects/${encodeURIComponent(id)}/background-upload?name=${encodeURIComponent(f.name)}`, { method: 'POST', headers: { 'X-Studio': '1', 'Content-Type': 'application/octet-stream' }, body: f });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
      await load(true); set(j.bg);
    } catch (err) { toast(err.message); }
    btn.disabled = false; btn.textContent = 'Upload…';
  };
  $('#bgSave').onclick = async () => {
    try { const r = await api(`/api/projects/${encodeURIComponent(id)}/background`, { op: 'save', file: get().bg.file }); toast(`Saved to your library: ${r.saved}`); await load(true); }
    catch (e) { toast(e.message); }
  };
  $('#bgGen').onclick = () => { $('#bgGenBox').hidden = !$('#bgGenBox').hidden; if (!$('#bgGenBox').hidden) $('#bgPrompt').focus(); };
  $('#bgGenX').onclick = () => { $('#bgGenBox').hidden = true; };
  const gen = async () => {
    const prompt = $('#bgPrompt').value.trim();
    if (!prompt) return $('#bgPrompt').focus();
    $('#bgGenGo').disabled = true;
    try {
      await api(`/api/projects/${encodeURIComponent(id)}/background`, { op: 'generate', prompt });
      $('#bgPrompt').value = ''; $('#bgGenBox').hidden = true;
      toast('Sent to Claude. The new background lands in your library and on this canvas.');
    } catch (e) { toast(e.message); }
    $('#bgGenGo').disabled = false;
  };
  $('#bgGenGo').onclick = gen;
  $('#bgPrompt').onkeydown = (e) => { if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); gen(); } if (e.key === 'Escape') $('#bgGenBox').hidden = true; };

  load(true);
  return {
    render, refresh: () => load(),
    // mtime of the file the current background uses, so the canvas reloads a code background Claude edited
    version: (file) => list.project.find((x) => x.file === file)?.v || '',
  };
}
