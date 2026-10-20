// Timeline core, shared by the canvas timeline (web/timeline.js) and the scene timeline (web/scenetimeline.js).
// One <canvas> per timeline, drawn only when something changed and only for what's in view, so long takes stay fast.
// The core owns: the view (zoom around the pointer, pans, Fit, zoom to selection / to the I-O range, the zoom slider),
// the ruler and the playhead (click or drag the ruler, drag the playhead's handle; a time label rides on it), lanes with
// a header each (name, hide / mute / lock, drag the bottom edge to resize; remembered per project), selection (click,
// shift-click, drag across empty space for a marquee), moving and edge-trimming items with snapping you can see (a line
// and "Snaps to 'plan' · 0:25.90"; hold ⌘ while dragging to turn it off), keys (J/K/L shuttle, ←/→ frames, ⇧←/→ seconds,
// I/O, Home/End, ⌘Z / ⇧⌘Z, Delete, ⌘D, S / ⌘B split (with cfg.splitShot: S splits a shot, ⇧S / ⌘B the section), "/"
// (cfg.slash), ? for the sheet) and the undo stack (makeUndo, one per project).
// The timelines add their lanes: each lane draws itself and lists its items; what an edit means is up to the timeline.
import { h, esc, isMac } from './ui.js';

export const c2 = (t) => { const neg = t < 0; t = Math.abs(t || 0); const m = Math.floor(t / 60); return `${neg ? '−' : ''}${m}:${(t % 60).toFixed(2).padStart(5, '0')}`; };
// A colour with a new alpha: '#2563eb' or 'rgb(…)' → 'rgba(37,99,235,a)' (Edit Bay's literals came out exactly so).
export function alpha(c, a) {
  c = String(c || '').trim();
  let m = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})/i.exec(c);
  if (m) return `rgba(${parseInt(m[1], 16)},${parseInt(m[2], 16)},${parseInt(m[3], 16)},${a})`;
  m = /^#([0-9a-f])([0-9a-f])([0-9a-f])$/i.exec(c);
  if (m) return `rgba(${parseInt(m[1] + m[1], 16)},${parseInt(m[2] + m[2], 16)},${parseInt(m[3] + m[3], 16)},${a})`;
  m = /^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)/i.exec(c);
  return m ? `rgba(${m[1]},${m[2]},${m[3]},${a})` : c;
}
// A token's colour in a form a canvas takes: a look may write a colour as color-mix(…), which the page resolves.
let probe = null;
export function canvasColor(c) {
  c = String(c || '').trim();
  if (!/^(color-mix|color\(|oklch|oklab|lab\(|lch\()/i.test(c)) return c;
  probe ||= document.createElement('i');
  probe.style.cssText = 'position:absolute;width:0;height:0;visibility:hidden'; probe.style.color = c;
  document.body.append(probe);
  const v = getComputedStyle(probe).color; probe.remove();
  const m = /color\(srgb ([\d.e-]+) ([\d.e-]+) ([\d.e-]+)(?: \/ ([\d.e-]+))?\)/.exec(v);
  return m ? `rgba(${Math.round(m[1] * 255)},${Math.round(m[2] * 255)},${Math.round(m[3] * 255)},${m[4] ?? 1})` : v;
}
// The look's colours for a canvas (Settings → Appearance): tokens(el)(name, fallback), the fallback being Edit Bay's.
// Every canvas reads its colours here: the timelines, the trim lens, the blocks band, the canvas marks, the Renders wave.
export function tokens(el = document.documentElement) {
  const s = getComputedStyle(el);
  return (n, d) => canvasColor(s.getPropertyValue(n).trim() || d);
}
// Which look the page is in (Settings → Appearance): a canvas redraws with new colours when it changes.
export const lookKey = () => { const d = document.documentElement.dataset; return `${d.look || ''}${'calm' in d ? '+' : ''}`; };
const LS = (k, v) => { try { if (v === undefined) return localStorage.getItem(k); localStorage.setItem(k, v); } catch {} return null; };
const SNAP_PX = 8, EDGE_PX = 6, DRAG_PX = 3;
const cmd = (e) => (isMac ? e.metaKey : e.ctrlKey);
const ICON = {
  hide: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M1.5 8s2.4-4.5 6.5-4.5S14.5 8 14.5 8 12.1 12.5 8 12.5 1.5 8 1.5 8z"/><circle cx="8" cy="8" r="2"/></svg>',
  hidden: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M2 2l12 12M6.3 4c.5-.3 1.1-.5 1.7-.5 4.1 0 6.5 4.5 6.5 4.5s-.6 1.2-1.8 2.4M10 12c-.6.3-1.3.5-2 .5-4.1 0-6.5-4.5-6.5-4.5s.7-1.3 2-2.6"/></svg>',
  mute: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M2.5 6h2.5l3.5-3v10l-3.5-3h-2.5zM11 5.5c1.3 1.3 1.3 3.7 0 5"/></svg>',
  muted: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M2.5 6h2.5l3.5-3v10l-3.5-3h-2.5zM11 6l3.5 4M14.5 6L11 10"/></svg>',
  lock: '<svg viewBox="0 0 16 16" aria-hidden="true"><rect x="3.5" y="7" width="9" height="6.5" rx="1.2"/><path d="M5.5 7V5.2a2.5 2.5 0 0 1 5 0V7"/></svg>',
  locked: '<svg viewBox="0 0 16 16" aria-hidden="true"><rect x="3.5" y="7" width="9" height="6.5" rx="1.2" fill="currentColor"/><path d="M5.5 7V5.2a2.5 2.5 0 0 1 5 0V7"/></svg>',
  sel: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M2 5V2h3M11 2h3v3M14 11v3h-3M5 14H2v-3"/><rect x="5.5" y="5.5" width="5" height="5" rx="1"/></svg>',
};
const FLAG_TITLE = { hide: ['Hide in the picture', 'Show in the picture'], mute: ['Mute while playing here', 'Unmute'], lock: ['Lock: no edits on this lane', 'Unlock'] };

// ---------- undo: one stack per project, for edits made on the timelines ----------
// push({ label, undo: async () => …, redo: async () => … }); ⌘Z / ⇧⌘Z run them.
export function makeUndo({ toast } = {}) {
  const done = [], undone = [];
  let busy = false;
  async function run(from, to, verb) {
    if (busy) return;
    const e = from.pop();
    if (!e) { toast?.(verb === 'undo' ? 'Nothing to undo on the timeline.' : 'Nothing to redo.'); return; }
    busy = true;
    try { await (verb === 'undo' ? e.undo() : e.redo()); to.push(e); toast?.(`${verb === 'undo' ? 'Undid' : 'Redid'}: ${e.label}`); }
    catch (err) { toast?.(`Couldn't ${verb} “${e.label}”: ${err.message}`); }
    busy = false;
  }
  return {
    push(e) { done.push(e); if (done.length > 200) done.shift(); undone.length = 0; },
    undo: () => run(done, undone, 'undo'),
    redo: () => run(undone, done, 'redo'),
    sizes: () => [done.length, undone.length],
  };
}

// ---------- the track ----------
// cfg: id ('main'|'scene', for remembered lane state), project (id), title, cls, labelsW, minSpan, fps,
//   head (extra header HTML, left of the zoom), sub (HTML under the header),
//   bounds() → [lo, hi] the scrollable time range; home() → [a, b] for Home/End (default bounds); viewKey() → a new value refits
//   time(), playing(), seek(t), play(), pause(), media() (the element J/K/L change the rate of)
//   lanes() → [{ k, label, note (a small second line under the label), h, min, max, flags: ['hide','mute','lock'], scrub, cls, title, sub,
//                draw(g, r, V), items?() → [{ id, a, b, label, move, trim, point, seekOnClick, tip, host }], extra?(p, r, V) → { tip, cursor, click },
//                band?: { down, move, up, hover, dbl } (a lane that handles its own pointer: the blocks band, the Shots lane) }]
//   snaps() → [{ t, label, word? }]; guides() → [{ id, t, title, waiting, drag }] (full-height lines, e.g. a scene's edges)
//   shade() → [[a, b]] hatched (outside the scene); veil() → [[a, b]] faint (removed by the locked cut)
//   overlay(g, V, top, height) draws over every lane (under the playhead): labels and lines that cross lanes
//   pick(item, e) a click on an item; open(item) a double-click; selected(items) after the selection changed;
//   commit(op) op = { kind: 'move', items, dt } | { kind: 'trim', item, edge: 'a'|'b', t } | { kind: 'guide', guide, t }
//   remove(items), duplicate(items), split(t), splitShot(t) (S; then ⇧S and ⌘B are split(t)), slash(t) ("/"), escape() → true
//   when the page took Esc, hover(item|null), focusRange() → [a, b] | null, flags(k, {hide, mute, lock})
//   undo (makeUndo), toast(text), help: [[keys, what]], keyGuard(e) → true leaves a key to the page, sig() → redraw key
export function makeTrack(host, cfg) {
  const minSpan = cfg.minSpan || 1, fps = cfg.fps || 30;
  host.innerHTML = `<div class="tk ${cfg.cls || ''}">
    <div class="tl-head tk-head"><b>${esc(cfg.title || 'Timeline')}</b><span class="tl-range mono"></span><span class="tk-shuttle mono" hidden></span><span class="gap"></span><span class="tl-note"></span>
      ${cfg.head || ''}
      <span class="tk-io" hidden><span class="mono"></span><button class="btn ghost small" data-z="range" title="Zoom to the I–O range">Zoom to range</button><button class="btn ghost small tk-iox" data-a="io-clear" aria-label="Clear the range (⌥X)" title="Clear the range (⌥X)">×</button></span>
      <label class="toggle tk-snap" title="Edges and moves stick to the playhead, words, edges, cues and markers (hold ⌘ while dragging to turn it off)"><input type="checkbox" role="switch" checked><span class="sw" aria-hidden="true"></span><span class="tk-snap-l">Snap</span></label>
      <div class="tl-zoom tk-zoom" role="group" aria-label="Zoom the timeline">
        <button class="btn ghost small" data-z="out" aria-label="Zoom out (−)" title="Zoom out (−)">−</button>
        <input type="range" class="tk-zs" min="0" max="1000" step="1" aria-label="Zoom">
        <button class="btn ghost small" data-z="in" aria-label="Zoom in (=)" title="Zoom in (=)">+</button>
        <span class="tk-span mono"></span>
        <button class="btn ghost small" data-z="fit" title="Show everything (\\)">${esc(cfg.fitLabel || 'Fit')}</button>
        <button class="btn ghost small tk-zsel" data-z="sel" aria-label="Zoom to selection" title="Zoom to the selection">${ICON.sel}</button>
      </div>
      <button class="btn ghost small tk-help" aria-label="Timeline shortcuts" title="Shortcuts (?)">?</button></div>
    ${cfg.sub || ''}
    <div class="tl-body tk-body"><div class="tl-labels tk-labels" style="width:${cfg.labelsW || 104}px"></div>
      <div class="tl-lanes tk-lanes"><canvas class="tl-canvas tk-canvas" aria-label="${esc(cfg.title || 'Timeline')}: click or drag the ruler to move the playhead"></canvas><div class="tk-tip" hidden></div></div></div></div>`;
  const root = host.firstElementChild;
  const q = (s) => root.querySelector(s);
  const cv = q('.tk-canvas'), lanesEl = q('.tk-lanes'), labelsEl = q('.tk-labels'), body = q('.tk-body'), tip = q('.tk-tip');
  const snapBox = q('.tk-snap input'), zs = q('.tk-zs');
  let v0 = 0, v1 = 1, fitted = false, viewKey = null, W = 0, Hh = 0, dpr = 1, last = '', col = null, labelSig = '', colLook = '';
  let sel = new Set(), drag = null, hover = null, hoverKey = '', io = { a: null, b: null }, lastManual = 0;
  let shuttle = { rate: 0, raf: 0, at: 0 }, rows = [];

  // ---------- remembered lane state (per project and timeline) ----------
  const stateKey = `studio.tl.${cfg.project || ''}.${cfg.id || 'main'}`;
  let lanesState = (() => { try { return JSON.parse(LS(stateKey) || '{}'); } catch { return {}; } })();
  lanesState.h ||= {}; lanesState.hide ||= []; lanesState.mute ||= []; lanesState.lock ||= [];
  const saveState = () => LS(stateKey, JSON.stringify(lanesState));
  const flagOn = (k, f) => lanesState[f].includes(k);
  function setFlag(k, f, on) {
    lanesState[f] = lanesState[f].filter((x) => x !== k);
    if (on) lanesState[f].push(k);
    saveState(); labelSig = ''; last = '';
    cfg.flags?.(k, { hide: flagOn(k, 'hide'), mute: flagOn(k, 'mute'), lock: flagOn(k, 'lock') });
  }

  // The lanes' colours come from the look's tokens (Settings → Appearance); each fallback is Edit Bay's value.
  const colors = () => {
    const g = tokens(host);
    col = { text: g('--text', '#1a1a1c'), text2: g('--text-2', '#33333a'), muted: g('--muted', '#66666c'), faint: g('--faint', '#9a9994'), line: g('--line', '#e6e5e1'),
      line2: g('--line-2', '#d9d8d3'), line3: g('--line-3', '#efeeea'), word: g('--tl-word', '#f0efec'), wave: g('--tl-wave', '#8e8d88'), keep: g('--tl-keep', '#a9a8a3'),
      gone: g('--tl-gone', '#f0efec'), clip: g('--tl-clip', '#ecebe7'), clipText: g('--text-2', '#33333a'), sel: g('--sel', '#2563eb'), selSoft: g('--sel-soft', '#dce7fd'),
      accent: g('--accent', '#c2410c'), accentSoft: g('--accent-soft', '#c2410c14'), font: g('--font', 'system-ui'), mono: g('--mono', 'ui-monospace, monospace'),
      ok: g('--ok', '#16a34a'), warn: g('--warn', '#d97706'), scene: g('--tl-scene', '#ecebe7'), panel: g('--panel', '#fff'), panel3: g('--panel-3', '#f4f3f0'),
      bad: g('--bad', '#dc2626'), playhead: g('--playhead', g('--accent', '#c2410c')), playheadInk: g('--playhead-ink', '#fff'), inverse: g('--inverse', '#fff'),
      accentInk: g('--accent-ink', '#fff'), selInk: g('--sel-ink', '#fff'), selText: g('--sel-text', '#1e3a8a'),
      gfx: g('--gfx-bg', '#e7e6f5'), gfxInk: g('--gfx-ink', '#3b3a6b'), gfxOn: g('--gfx-on', '#d9d7f2'), gfxHover: g('--gfx-hover', '#dedcf2'), gfxDeep: g('--gfx-deep', '#efeefa'),
      gfxEdge: g('--gfx-edge', '#6d6ab8'), gfxLine: g('--gfx-line', '#b4b1f0'), cue: g('--cue-bg', '#fde7d9'), trim: g('--trim-wash', '#fde7d9'),
      shade: g('--shade', 'rgba(246,246,244,0.9)'), shadeLine: g('--shade-line', 'rgba(214,213,208,0.9)'), veil: g('--veil', 'rgba(120,118,112,0.07)'),
      veilLock: g('--veil-lock', 'rgba(120,118,112,0.06)'), veilHide: g('--veil-hide', 'rgba(246,246,244,0.7)'), voice: g('--wash', '#fbfbfa'), dash: g('--todo-ring', '#9a9994'),
      dashLine: g('--line-hover', '#c9c8c3'), tick: g('--tick', 'rgba(26,26,28,0.1)'), quiet: g('--panel-3', '#f0efec'), a: alpha };
    // Sound cues: Edit Bay draws them like clips; a look may give them its cue colours.
    col.cueLane = g('--cue-lane', col.clip); col.cueInk = g('--cue-lane-ink', col.clipText); col.cueMark = g('--cue-mark', col.wave); col.cueText = g('--cue-text', col.accent);
    col.gfxMark = g('--gfx-edge', '#6d6aa8'); col.resolvedInk = g('--resolved-ink', '#fff');
    col.panelSolid = g('--pop-bg', col.panel); // an opaque panel colour, for tags drawn over other clips (glass looks)
    colLook = lookKey();
  };

  // ---------- view ----------
  const bounds = () => { const b = cfg.bounds(); return [b[0], Math.max(b[0] + 0.01, b[1])]; };
  const span = () => Math.max(1e-3, v1 - v0);
  const xOf = (t) => ((t - v0) / span()) * W;
  const tOf = (x) => v0 + (x / Math.max(1, W)) * span();
  function clampView() {
    const [lo, hi] = bounds();
    const s = Math.min(Math.max(minSpan, v1 - v0), Math.max(minSpan, hi - lo));
    v0 = Math.max(lo, Math.min(v0, hi - s)); if (hi - lo < s) v0 = lo;
    v1 = v0 + s; last = '';
  }
  function zoomAt(t, k) {
    const [lo, hi] = bounds();
    const s = Math.max(minSpan, Math.min(Math.max(minSpan, hi - lo), span() * k)), f = (t - v0) / span();
    v0 = t - f * s; v1 = v0 + s; clampView();
  }
  function fit() { const [lo, hi] = bounds(); v0 = lo; v1 = Math.max(lo + minSpan, hi); last = ''; }
  // Bring a range into view: zoom to it (with a margin), or only scroll when `scrollOnly`.
  function show(a, b, scrollOnly = false) {
    if (!(b > a)) b = a + 0.5;
    if (scrollOnly) { if (a >= v0 && b <= v1) return; const s = span(); if (b - a > s) { v0 = a; v1 = b; } else { v0 = a - (s - (b - a)) / 2; v1 = v0 + s; } }
    else { const m = (b - a) * 0.08 + 0.05; v0 = a - m; v1 = b + m; }
    clampView();
  }
  const zoomCenter = () => { const t = cfg.time(); return t >= v0 && t <= v1 ? t : (v0 + v1) / 2; };
  const manual = () => { lastManual = performance.now(); };
  // The zoom slider is logarithmic between the shortest span and the whole range.
  const sliderOf = () => { const [lo, hi] = bounds(), full = Math.max(minSpan * 1.0001, hi - lo); return Math.round((1 - Math.log(span() / minSpan) / Math.log(full / minSpan)) * 1000); };
  zs.addEventListener('input', () => {
    const [lo, hi] = bounds(), full = Math.max(minSpan * 1.0001, hi - lo);
    const s = minSpan * Math.exp((1 - zs.value / 1000) * Math.log(full / minSpan));
    zoomAt(zoomCenter(), s / span()); manual();
  });
  root.querySelectorAll('[data-z]').forEach((b) => (b.onclick = () => zoomCmd(b.dataset.z)));
  function zoomCmd(z) {
    if (z === 'fit') fit();
    else if (z === 'in' || z === 'out') zoomAt(zoomCenter(), z === 'in' ? 0.5 : 2);
    else if (z === 'range' && io.a != null && io.b != null) show(io.a, io.b);
    else if (z === 'sel') { const r = selRange(); if (r) show(r[0], r[1]); else cfg.toast?.('Select something on the timeline first.'); }
    manual(); last = '';
  }
  q('[data-a=io-clear]').onclick = () => { io = { a: null, b: null }; last = ''; };
  q('.tk-help').onclick = () => helpSheet();
  snapBox.addEventListener('change', () => LS(`studio.tl.snap.${cfg.id}`, snapBox.checked ? '1' : '0'));
  if (LS(`studio.tl.snap.${cfg.id}`) === '0') snapBox.checked = false;

  const ro = new ResizeObserver(() => { W = 0; last = ''; });
  ro.observe(lanesEl);

  // ---------- lanes ----------
  function layout() {
    const list = [{ k: 'ruler', h: 24, label: '', ruler: true }, ...cfg.lanes()];
    let y = 0;
    rows = list.map((l) => {
      const hh = l.ruler ? 24 : Math.max(l.min || 14, Math.min(l.max || 400, lanesState.h[l.k] || l.h || 24));
      const r = { ...l, y, h: hh, lane: l, hidden: flagOn(l.k, 'hide'), muted: flagOn(l.k, 'mute'), locked: flagOn(l.k, 'lock') };
      y += hh;
      return r;
    });
    return rows;
  }
  const rowAt = (y) => rows.find((r) => y >= r.y && y < r.y + r.h) || null;
  function size() {
    const w = lanesEl.clientWidth, hh = rows.reduce((s, r) => s + r.h, 0) + 2;
    dpr = window.devicePixelRatio || 1;
    if (w !== W || hh !== Hh || !col) { W = w; Hh = hh; cv.width = Math.round(w * dpr); cv.height = Math.round(hh * dpr); cv.style.height = `${hh}px`; colors(); }
    const sig = rows.map((r) => `${r.k}:${r.label}:${r.note || ''}:${r.h}:${r.cls || ''}:${(r.flags || []).map((f) => `${f}${flagOn(r.k, f) ? 1 : 0}`).join('')}`).join('|');
    if (sig === labelSig) return;
    labelSig = sig;
    labelsEl.replaceChildren(...rows.map((r) => {
      const flags = (r.flags || []).map((f) => {
        const on = flagOn(r.k, f), ic = on ? { hide: ICON.hidden, mute: ICON.muted, lock: ICON.locked }[f] : ICON[f];
        return `<button class="tk-f${on ? ' on' : ''}" data-f="${f}" aria-pressed="${on}" aria-label="${esc(FLAG_TITLE[f][on ? 1 : 0])} · ${esc(r.label)}" title="${esc(FLAG_TITLE[f][on ? 1 : 0])}">${ic}</button>`;
      }).join('');
      const el = h(`<div class="tk-lh${r.ruler ? ' ruler' : ''}${r.cls ? ` ${r.cls}` : ''}${r.sub ? ' sub' : ''}" data-k="${esc(r.k)}" style="height:${r.h}px"${r.title ? ` title="${esc(r.title)}"` : ''}>
        <span class="tk-ln">${esc(r.label || '')}${r.note ? `<small class="tk-lnote">${esc(r.note)}</small>` : ''}</span>${flags ? `<span class="tk-fl">${flags}</span>` : ''}${!r.ruler && r.resizable !== false ? '<i class="tk-rs" aria-hidden="true"></i>' : ''}</div>`);
      el.querySelectorAll('[data-f]').forEach((b) => (b.onclick = () => setFlag(r.k, b.dataset.f, !flagOn(r.k, b.dataset.f))));
      el.querySelector('.tk-rs')?.addEventListener('pointerdown', (e) => resizeLane(e, r));
      el.addEventListener('dblclick', (e) => { if (e.target.closest('.tk-rs')) { delete lanesState.h[r.k]; saveState(); labelSig = ''; last = ''; } });
      return el;
    }));
  }
  function resizeLane(e, r) {
    e.preventDefault(); e.stopPropagation();
    const y0 = e.clientY, h0 = r.h, el = e.currentTarget;
    try { el.setPointerCapture(e.pointerId); } catch {}
    document.body.classList.add('rs-ns');
    const mv = (ev) => { lanesState.h[r.k] = Math.round(Math.max(r.min || 14, Math.min(r.max || 400, h0 + ev.clientY - y0))); labelSig = ''; last = ''; };
    const up = () => { el.removeEventListener('pointermove', mv); el.removeEventListener('pointerup', up); document.body.classList.remove('rs-ns'); saveState(); };
    el.addEventListener('pointermove', mv); el.addEventListener('pointerup', up);
  }

  // ---------- items, hits, snapping ----------
  const itemsOf = (r) => (r.items ? r.items() : []);
  const isSel = (id) => sel.has(id);
  // During a drag the moving items draw where they would land.
  function pos(it) {
    if (drag?.kind === 'move' && drag.ids.has(it.id)) return { a: it.a + drag.dt, b: it.b + drag.dt };
    if (drag?.kind === 'trim' && drag.item.id === it.id) return drag.edge === 'a' ? { a: drag.t, b: it.b } : { a: it.a, b: drag.t };
    return { a: it.a, b: it.b };
  }
  function hitItem(p, r) {
    const list = itemsOf(r);
    // Points (keys, cues' starts, pins) first, then ranges, topmost (last) first.
    for (const it of [...list].reverse()) if (it.point || it.b <= it.a) { if (Math.abs(xOf(it.a) - p.x) <= EDGE_PX) return { it, part: 'body' }; }
    for (const it of [...list].reverse()) {
      if (it.point || it.b <= it.a) continue;
      const xa = xOf(it.a), xb = Math.max(xa + (it.minW || 0), xOf(it.b)), wide = xb - xa > 16;
      if (p.x < xa - EDGE_PX || p.x > xb + EDGE_PX) continue;
      if (it.trim && wide && Math.abs(p.x - xa) <= EDGE_PX) return { it, part: 'a' };
      if (it.trim && wide && Math.abs(p.x - xb) <= EDGE_PX) return { it, part: 'b' };
      if (p.x >= xa && p.x <= xb) return { it, part: 'body' };
    }
    return null;
  }
  const guideAt = (p) => (cfg.guides?.() || []).find((g) => g.drag && Math.abs(xOf(drag?.kind === 'guide' && drag.g.id === g.id ? drag.t : g.t) - p.x) <= 5) || null;
  // Everything a drag can stick to, minus what's moving.
  function snapList(skip) {
    const out = [{ t: cfg.time(), label: 'the playhead' }];
    if (io.a != null) out.push({ t: io.a, label: 'In' });
    if (io.b != null) out.push({ t: io.b, label: 'Out' });
    for (const r of rows) for (const it of itemsOf(r)) {
      if (skip.has(it.id) || it.snap === false) continue;
      out.push({ t: it.a, label: it.label ? `${it.label}${it.point || it.b <= it.a ? '' : ' start'}` : 'an edge' });
      if (it.b > it.a && !it.point) out.push({ t: it.b, label: it.label ? `${it.label} end` : 'an edge' });
    }
    for (const g of cfg.guides?.() || []) if (!skip.has(g.id)) out.push({ t: g.t, label: g.title || 'an edge' });
    for (const s of cfg.snaps?.() || []) out.push(s);
    return out;
  }
  function snapT(t, list, on) {
    if (!on) return { t, s: null };
    let best = null;
    for (const s of list) { const d = Math.abs(xOf(s.t) - xOf(t)); if (d <= SNAP_PX && (!best || d < best.d)) best = { s, d }; }
    return best ? { t: best.s.t, s: best.s } : { t, s: null };
  }
  const snapOn = (e) => (snapBox.checked ? !cmd(e) : cmd(e));
  const snapText = (s, t) => (s ? `Snaps to ${s.word ? `“${s.word}”` : s.label} · ${c2(t)}` : c2(t));
  // For lanes that drag on their own (the blocks band): snap through the core so it looks and feels the same.
  function laneSnap(t, e, extra = []) {
    const r = snapT(t, [...snapList(new Set()), ...extra], e ? snapOn(e) : snapBox.checked);
    drag && (drag.snapLine = { t: r.t, text: snapText(r.s, r.t) });
    return r.t;
  }

  // ---------- selection ----------
  function setSel(ids, notify = true) {
    sel = new Set(ids);
    last = '';
    if (notify) cfg.selected?.(selItems());
  }
  function selItems() { const out = []; for (const r of rows) for (const it of itemsOf(r)) if (sel.has(it.id)) out.push({ ...it, lane: r.k, locked: r.locked }); return out; }
  function selRange() {
    const list = selItems();
    if (list.length) return [Math.min(...list.map((x) => x.a)), Math.max(...list.map((x) => Math.max(x.a, x.b)))];
    return cfg.focusRange?.() || null;
  }

  // ---------- pointer ----------
  const at = (e) => { const b = cv.getBoundingClientRect(); return { x: e.clientX - b.left, y: e.clientY - b.top }; };
  const clampT = (t) => { const [lo, hi] = bounds(); return Math.max(lo, Math.min(hi, t)); };
  const V = () => ({ xOf, tOf, v0, v1, W, col, dpr, isSel, pos, time: cfg.time(), snap: laneSnap, snapOn, hoverId: hover?.it?.id || null, c2 });
  function scrubTo(x) { cfg.seek(clampT(tOf(x))); lastManual = 0; }
  cv.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    hideTip();
    const p = at(e), r = rowAt(p.y);
    try { cv.setPointerCapture(e.pointerId); } catch {}
    const near = Math.abs(xOf(cfg.time()) - p.x) <= 7;
    if (!r || r.ruler || (near && p.y < 30)) { drag = { kind: 'scrub' }; scrubTo(p.x); return; }
    if (r.band && !r.locked) {
      const v = V();
      if (r.band.down(p, r, v, e)) { drag = { kind: 'band', r, e }; if (sel.size) setSel([]); return; }
      if (sel.size) setSel([]);
      drag = { kind: 'scrub' }; scrubTo(p.x); return;
    }
    const hit = e.shiftKey && !itemsOf(r).length ? null : hitItem(p, r);
    // A marker (◇) on top of a clip takes the click; dragging from it still moves the clip.
    const ex = !e.shiftKey && (!hit || (hit.part === 'body' && !hit.it.point)) ? r.extra?.(p, r, V()) : null;
    if (ex) { drag = { kind: 'extra', ex, hit, r, x0: p.x, y0: p.y, e }; return; }
    if (hit) {
      const it = hit.it;
      drag = { kind: 'pending', it, part: hit.part, r, x0: p.x, y0: p.y, shift: e.shiftKey, e };
      return;
    }
    const gd = guideAt(p);
    if (gd && !r.locked) { drag = { kind: 'guide', g: gd, t: gd.t, x0: p.x, moved: false }; return; }
    if (e.shiftKey || (!r.scrub && r.items)) { drag = { kind: 'marquee', x0: p.x, y0: p.y, x1: p.x, y1: p.y, add: e.shiftKey, base: new Set(sel), moved: false }; return; }
    drag = { kind: 'scrub' }; scrubTo(p.x);
    if (sel.size) setSel([]);
  });
  cv.addEventListener('pointermove', (e) => {
    const p = at(e);
    if (!drag) return hoverAt(p, e);
    if (drag.kind === 'scrub') return scrubTo(p.x);
    if (drag.kind === 'band') { drag.e = e; drag.r.band.move(p, drag.r, V(), e); last = ''; return; }
    if (drag.kind === 'guide') {
      if (Math.abs(p.x - drag.x0) > DRAG_PX) drag.moved = true;
      if (!drag.moved) return;
      const sn = snapT(clampT(tOf(p.x)), snapList(new Set([drag.g.id])), snapOn(e));
      drag.t = sn.t; drag.snapLine = { t: sn.t, text: snapText(sn.s, sn.t) }; last = ''; return;
    }
    if (drag.kind === 'marquee') {
      drag.x1 = p.x; drag.y1 = p.y;
      if (Math.abs(p.x - drag.x0) + Math.abs(p.y - drag.y0) > DRAG_PX) drag.moved = true;
      if (drag.moved) marquee();
      return;
    }
    if (drag.kind === 'extra') {
      if (Math.abs(p.x - drag.x0) <= DRAG_PX) return;
      if (!drag.hit) { drag = { kind: 'scrub' }; return scrubTo(p.x); }
      drag = { kind: 'pending', it: drag.hit.it, part: drag.hit.part, r: drag.r, x0: drag.x0, y0: drag.y0, e: drag.e };
    }
    if (drag.kind === 'pending') {
      if (Math.abs(p.x - drag.x0) <= DRAG_PX) return;
      const { it, part, r } = drag;
      if (r.locked) { drag = { kind: 'none' }; cfg.toast?.(`${r.label} is locked.`); return; }
      if (part !== 'body' && it.trim) {
        if (!sel.has(it.id)) setSel([it.id]);
        drag = { kind: 'trim', item: it, edge: part, t: part === 'a' ? it.a : it.b, from: part === 'a' ? it.a : it.b };
      } else if (it.move) {
        if (!sel.has(it.id)) setSel(drag.shift ? [...sel, it.id] : [it.id]);
        const moving = selItems().filter((x) => x.move && !x.locked);
        drag = { kind: 'move', item: it, items: moving, ids: new Set(moving.map((x) => x.id)), x0: drag.x0, dt: 0 };
      } else { drag = { kind: 'scrub' }; }
    }
    if (drag.kind === 'move') {
      const raw = tOf(p.x) - tOf(drag.x0);
      const [lo, hi] = bounds();
      const minA = Math.min(...drag.items.map((x) => x.a)), maxB = Math.max(...drag.items.map((x) => Math.max(x.a, x.b)));
      let dt = Math.max(lo - minA, Math.min(hi - maxB, raw));
      const list = snapList(drag.ids), on = snapOn(e), it = drag.item;
      const sa = snapT(it.a + dt, list, on), sb = it.b > it.a ? snapT(it.b + dt, list, on) : { s: null };
      let s = null;
      if (sa.s && (!sb.s || Math.abs(sa.t - (it.a + dt)) <= Math.abs(sb.t - (it.b + dt)))) { dt = sa.t - it.a; s = { t: sa.t, s: sa.s }; }
      else if (sb.s) { dt = sb.t - it.b; s = { t: sb.t, s: sb.s }; }
      drag.dt = dt;
      drag.snapLine = s ? { t: s.t, text: snapText(s.s, s.t) } : { t: it.a + dt, text: `${c2(it.a + dt)}  (${dt >= 0 ? '+' : '−'}${Math.abs(dt).toFixed(2)} s)` };
      last = '';
    } else if (drag.kind === 'trim') {
      const it = drag.item, sn = snapT(clampT(tOf(p.x)), snapList(new Set([it.id])), snapOn(e));
      drag.t = drag.edge === 'a' ? Math.min(sn.t, it.b - 0.05) : Math.max(sn.t, it.a + 0.05);
      drag.snapLine = { t: drag.t, text: snapText(sn.s, drag.t) };
      last = '';
    }
  });
  cv.addEventListener('pointerup', async (e) => {
    const d = drag;
    drag = null;
    last = '';
    if (!d) return;
    if (d.kind === 'band') { await d.r.band.up(e); last = ''; return; }
    if (d.kind === 'extra') { d.ex.click?.(); return; }
    if (d.kind === 'marquee') { if (!d.moved) { if (sel.size) setSel([]); scrubTo(d.x0); } else cfg.selected?.(selItems()); return; }
    if (d.kind === 'pending') {
      const { it } = d;
      if (d.shift) { const s = new Set(sel); s.has(it.id) ? s.delete(it.id) : s.add(it.id); setSel([...s]); }
      else if (!it.host) setSel([it.id]);
      else if (sel.size) setSel([]);
      if (it.seekOnClick) cfg.seek(clampT(it.seekAt ?? tOf(d.x0)));
      cfg.pick?.(it, d.e);
      return;
    }
    if (d.kind === 'move' && Math.abs(d.dt) > 0.004) await cfg.commit?.({ kind: 'move', items: d.items, dt: Math.round(d.dt * 1000) / 1000 });
    if (d.kind === 'trim' && Math.abs(d.t - d.from) > 0.004) await cfg.commit?.({ kind: 'trim', item: d.item, edge: d.edge, t: Math.round(d.t * 1000) / 1000 });
    if (d.kind === 'guide' && d.moved && Math.abs(d.t - d.g.t) > 0.004) await cfg.commit?.({ kind: 'guide', guide: d.g, t: Math.round(d.t * 1000) / 1000 });
    last = '';
  });
  cv.addEventListener('dblclick', (e) => {
    const p = at(e), r = rowAt(p.y);
    if (r?.band?.dbl && !r.locked) { r.band.dbl(p, r, V(), e); return; } // a lane that handles its own pointer
    const hit = r && !r.ruler && hitItem(p, r);
    if (hit) cfg.open?.(hit.it);
  });
  cv.addEventListener('pointerleave', () => { if (!drag) { hideTip(); setHover(null); } });
  function marquee() {
    const xa = Math.min(drag.x0, drag.x1), xb = Math.max(drag.x0, drag.x1), ya = Math.min(drag.y0, drag.y1), yb = Math.max(drag.y0, drag.y1);
    const ta = tOf(xa), tb = tOf(xb), found = [];
    for (const r of rows) {
      if (r.locked || r.y + r.h < ya || r.y > yb) continue;
      for (const it of itemsOf(r)) if (!it.host && it.select !== false && Math.max(it.a, it.b) >= ta && it.a <= tb) found.push(it.id);
    }
    setSel(drag.add ? [...drag.base, ...found] : found, false);
  }

  // ---------- hover: tooltips, cursors, the picture follows ----------
  function hoverAt(p, e) {
    const r = rowAt(p.y);
    let cursor = '', text = '', it = null;
    if (!r || r.ruler) cursor = 'col-resize';
    else if (r.band) { const hv = r.band.hover?.(p, r, V()) || {}; cursor = hv.cursor || ''; text = hv.title || ''; }
    else {
      const hit = hitItem(p, r);
      const ex = !hit || (hit.part === 'body' && !hit.it.point) ? r.extra?.(p, r, V()) : null;
      if (ex) { cursor = ex.cursor || 'pointer'; text = ex.tip || ''; it = hit?.it || null; }
      else if (hit) {
        it = hit.it;
        cursor = r.locked ? 'not-allowed' : hit.part !== 'body' ? 'ew-resize' : it.move ? 'grab' : 'pointer';
        text = typeof it.tip === 'function' ? it.tip() : it.tip || '';
      } else if (guideAt(p)) { cursor = 'ew-resize'; text = guideAt(p).title || ''; }
      else cursor = r.scrub ? 'text' : '';
    }
    cv.style.cursor = cursor;
    if (text) showTip(text, p.x, r ? r.y + r.h : p.y); else hideTip();
    setHover(it ? { it, r } : null);
  }
  function setHover(hv) {
    const k = hv ? hv.it.id : '';
    if (k === hoverKey) return;
    hoverKey = k; hover = hv; last = '';
    cfg.hover?.(hv ? hv.it : null);
  }
  function showTip(text, x, y) {
    tip.textContent = text; tip.hidden = false;
    const w = tip.offsetWidth;
    tip.style.left = `${Math.max(2, Math.min(W - w - 2, x + 10))}px`; tip.style.top = `${y + 4}px`;
  }
  function hideTip() { tip.hidden = true; }

  // ---------- wheel: ⌘ / ctrl (and pinch) zooms around the pointer, shift or sideways pans, plain scrolls lanes ----------
  lanesEl.addEventListener('wheel', (e) => {
    const p = at(e);
    if (e.ctrlKey || e.metaKey) {
      e.preventDefault();
      const k = Math.exp(Math.max(-0.7, Math.min(0.7, e.deltaY * (e.deltaMode ? 0.3 : 0.01))));
      zoomAt(tOf(p.x), k); manual(); return;
    }
    let d = e.shiftKey ? e.deltaY || e.deltaX : Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : 0;
    if (!d && e.deltaY) {
      // Vertical: scroll the lanes when they overflow, otherwise pan (the old behaviour for a short timeline).
      const canScroll = body.scrollHeight > body.clientHeight + 1 && ((e.deltaY > 0 && body.scrollTop + body.clientHeight < body.scrollHeight - 1) || (e.deltaY < 0 && body.scrollTop > 0));
      if (canScroll) return;
      d = e.deltaY;
    }
    e.preventDefault();
    const s = span(); v0 += (d * (e.deltaMode ? 16 : 1) / Math.max(1, W)) * s; v1 = v0 + s; clampView(); manual();
  }, { passive: false });
  // Safari's pinch.
  let gs = 1;
  lanesEl.addEventListener('gesturestart', (e) => { e.preventDefault(); gs = 1; });
  lanesEl.addEventListener('gesturechange', (e) => { e.preventDefault(); const p = at(e); zoomAt(tOf(p.x), gs / e.scale); gs = e.scale; manual(); });

  // ---------- keys ----------
  const visible = () => host.isConnected && host.offsetParent !== null && !host.closest('[hidden]');
  function onKey(e) {
    if (!visible() || cfg.active?.() === false) return;
    const ae = document.activeElement;
    if (ae && (/^(INPUT|TEXTAREA|SELECT)$/.test(ae.tagName) || ae.isContentEditable)) { if (!(ae === zs || ae === snapBox)) return; }
    const modal = document.getElementById('modal');
    if (modal && !modal.hidden) return;
    if (cfg.keyGuard?.(e)) return;
    const k = e.key, mods = e.metaKey || e.ctrlKey || e.altKey;
    if (k === ' ' || e.code === 'Space') { stopShuttle(true); return; } // the page plays/pauses; shuttle goes back to 1×
    if (cmd(e) && (k === 'z' || k === 'Z')) { e.preventDefault(); e.shiftKey ? cfg.undo?.redo() : cfg.undo?.undo(); return; }
    if (cmd(e) && (k === 'y' || k === 'Y')) { e.preventDefault(); cfg.undo?.redo(); return; }
    if (cmd(e) && (k === 'd' || k === 'D')) { e.preventDefault(); cfg.duplicate?.(selItems().filter((x) => !x.locked)); return; }
    if (cmd(e) && (k === 'b' || k === 'B')) { e.preventDefault(); cfg.split?.(cfg.time()); return; }
    if (e.altKey && (e.code === 'KeyX')) { e.preventDefault(); io = { a: null, b: null }; last = ''; return; }
    if (k === '?') { e.preventDefault(); helpSheet(); return; }
    if (mods) return;
    const t = cfg.time();
    switch (k) {
      case 'j': case 'J': e.preventDefault(); shuttleBy(-1); break;
      case 'k': case 'K': e.preventDefault(); stopShuttle(); cfg.pause(); break;
      case 'l': case 'L': e.preventDefault(); shuttleBy(1); break;
      case 'ArrowLeft': case 'ArrowRight': {
        e.preventDefault(); stopShuttle(); if (cfg.playing()) cfg.pause();
        const step = e.shiftKey ? 1 : 1 / fps, dir = k === 'ArrowLeft' ? -1 : 1;
        cfg.seek(clampT(Math.round((t + dir * step) * fps) / fps)); lastManual = 0; break;
      }
      case 'i': case 'I': e.preventDefault(); io.a = t; if (io.b != null && io.b <= t) io.b = null; last = ''; break;
      case 'o': case 'O': e.preventDefault(); io.b = t; if (io.a != null && io.a >= t) io.a = null; last = ''; break;
      case 'Home': { e.preventDefault(); const [a] = cfg.home?.() || bounds(); cfg.seek(a); lastManual = 0; break; }
      case 'End': { e.preventDefault(); const [, b] = cfg.home?.() || bounds(); cfg.seek(b - 0.01); lastManual = 0; break; }
      case 'Delete': case 'Backspace': if (cfg.remove?.(selItems().filter((x) => !x.locked))) e.preventDefault(); break;
      // S splits; on a timeline with shots S splits the shot and ⇧S the section (the blocks band), as ⌘B does.
      case 's': case 'S': e.preventDefault(); if (cfg.splitShot && !e.shiftKey) cfg.splitShot(t); else cfg.split?.(t); break;
      case '/': if (cfg.slash) { e.preventDefault(); cfg.slash(t); } break;
      case '=': case '+': e.preventDefault(); zoomCmd('in'); break;
      case '-': case '_': e.preventDefault(); zoomCmd('out'); break;
      case '\\': e.preventDefault(); zoomCmd('fit'); break;
      case 'Escape': if (helpEl) closeHelp(); else if (cfg.escape?.()) break; else if (sel.size) setSel([]); break;
      default:
    }
  }
  document.addEventListener('keydown', onKey);

  // J/K/L: L plays (again: 2×, 4×, 8×), J the same backwards (seeking frame by frame), K stops.
  function shuttleBy(dir) {
    const cur = shuttle.rate;
    const next = cur * dir > 0 ? Math.min(8, Math.abs(cur) * 2) * dir : dir;
    stopShuttle();
    shuttle.rate = next;
    if (next > 0) {
      const m = cfg.media?.();
      if (m) m.playbackRate = next;
      if (!cfg.playing()) cfg.play();
    } else {
      if (cfg.playing()) cfg.pause();
      shuttle.at = performance.now();
      const step = () => {
        const now = performance.now(), t = cfg.time() + ((now - shuttle.at) / 1000) * shuttle.rate;
        shuttle.at = now;
        const [lo] = cfg.home?.() || bounds();
        if (t <= lo) { cfg.seek(lo); stopShuttle(); return; }
        cfg.seek(t);
        shuttle.raf = requestAnimationFrame(step);
      };
      shuttle.raf = requestAnimationFrame(step);
    }
    lastManual = 0; last = '';
  }
  function stopShuttle(keepRate) {
    cancelAnimationFrame(shuttle.raf); shuttle.raf = 0;
    if (shuttle.rate !== 0 || !keepRate) { const m = cfg.media?.(); if (m && m.playbackRate !== 1) m.playbackRate = 1; }
    shuttle.rate = 0; last = '';
  }

  // ---------- the shortcut sheet ----------
  let helpEl = null;
  function helpSheet() {
    if (helpEl) return closeHelp();
    const rowsH = [['Space', 'Play / pause'], ['J · K · L', 'Shuttle back · stop · forward (press again: faster)'], ['← →', 'One frame'], ['⇧← ⇧→', 'One second'],
      ['I · O', 'Mark in · out (⌥X clears)'], ['Home · End', 'Start · end'], ['Click · drag the ruler', 'Move the playhead'],
      ['⌘ + scroll · pinch', 'Zoom around the pointer'], ['⇧ + scroll', 'Pan sideways'], ['= · − · \\', 'Zoom in · out · fit'],
      ['Click · ⇧-click', 'Select · add to the selection'], ['Drag empty space', 'Select several'], ['Drag · drag an edge', 'Move · trim (snaps; hold ⌘ to place freely)'],
      ['Delete', 'Delete the selection'], ['⌘D', 'Duplicate'], ...(cfg.splitShot ? [['S', 'Split the shot at the playhead'], ['⇧S · ⌘B', 'Split the section at the playhead']] : [['S · ⌘B', 'Split the block at the playhead']]),
      ['⌘Z · ⇧⌘Z', 'Undo · redo timeline edits'], ...(cfg.help || []), ['?', 'This sheet']];
    helpEl = h(`<div class="tk-sheet" role="dialog" aria-label="Timeline shortcuts"><div class="tk-sheet-h"><b>Timeline shortcuts</b><button class="btn ghost small" aria-label="Close">✕</button></div>
      <dl>${rowsH.map(([a, b]) => `<dt><kbd>${esc(a)}</kbd></dt><dd>${esc(b)}</dd>`).join('')}</dl></div>`);
    helpEl.querySelector('button').onclick = closeHelp;
    document.body.append(helpEl);
    setTimeout(() => document.addEventListener('pointerdown', outsideHelp, true), 0);
  }
  const outsideHelp = (e) => { if (helpEl && !helpEl.contains(e.target)) closeHelp(); };
  function closeHelp() { helpEl?.remove(); helpEl = null; document.removeEventListener('pointerdown', outsideHelp, true); }

  // ---------- drawing ----------
  const tickStep = () => [1 / fps, 0.1, 0.2, 0.25, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 1800].find((s) => (s / span()) * W >= 58) || 1800;
  const tlabel = (t, step) => {
    const neg = t < -1e-6; t = Math.abs(t);
    const m = Math.floor(t / 60), s = t - m * 60;
    const txt = step < 1 ? `${m}:${s.toFixed(step < 0.1 ? 2 : 1).padStart(step < 0.1 ? 5 : 4, '0')}` : `${m}:${String(Math.round(s)).padStart(2, '0')}`;
    return (neg && /[1-9]/.test(txt) ? '−' : '') + txt; // no "−0:00"
  };
  // The clock the creator reads: cfg.clock() → a cut map ({toCut, toSource}) while the canvas plays the cut (the ruler,
  // the playhead's flag and the header then say the cut's time, though the lanes stay laid out on the take), else null.
  const clockMap = () => cfg.clock?.() || null;
  const shownT = (t) => { const m = clockMap(); return m ? m.toCut(t) : t; };

  function draw() {
    const [lo, hi] = bounds();
    if (!(hi > lo)) return;
    const vk = cfg.viewKey?.();
    if (!fitted || vk !== viewKey) { viewKey = vk; fitted = true; fit(); }
    const t = cfg.time(), playing = cfg.playing();
    // While playing, page along so the playhead stays in view (unless you just scrolled or zoomed by hand).
    if (playing && !drag && performance.now() - lastManual > 1500 && (t > v1 - span() * 0.02 || t < v0)) { const s = span(); v0 = t - s * 0.08; v1 = v0 + s; clampView(); }
    layout();
    size();
    if (col && colLook !== lookKey()) { colors(); last = ''; } // the look changed (Settings → Appearance)
    if (!W || !col) return;
    const key = [t.toFixed(3), v0.toFixed(4), v1.toFixed(4), W, Hh, [...sel].join(), hoverKey, io.a, io.b, shuttle.rate, cfg.sig?.(), drag ? `${drag.kind}:${drag.dt ?? ''}:${drag.t ?? ''}:${drag.x1 ?? ''}:${drag.y1 ?? ''}:${drag.snapLine?.t ?? ''}` : ''].join('|');
    if (key === last) return;
    last = key;
    // Header bits.
    q('.tl-range').textContent = `${tlabel(shownT(Math.max(lo, v0, 0)), 1)} – ${tlabel(shownT(v1), 1)}`;
    q('.tk-span').textContent = span() < 10 ? `${span().toFixed(1)} s` : span() < 120 ? `${Math.round(span())} s` : `${Math.round(span() / 60)} min`;
    if (document.activeElement !== zs) zs.value = String(sliderOf());
    const ioEl = q('.tk-io');
    ioEl.hidden = io.a == null && io.b == null;
    if (!ioEl.hidden) { ioEl.querySelector('.mono').textContent = `${io.a != null ? `In ${c2(shownT(io.a))}` : 'In –'} · ${io.b != null ? `Out ${c2(shownT(io.b))}` : 'Out –'}`; ioEl.querySelector('[data-z=range]').disabled = io.a == null || io.b == null; }
    const sh = q('.tk-shuttle');
    sh.hidden = !shuttle.rate || (shuttle.rate === 1 && playing);
    if (!sh.hidden) sh.textContent = `${shuttle.rate < 0 ? '◀◀' : '▶▶'} ${Math.abs(shuttle.rate)}×`;

    const g = cv.getContext('2d');
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, W, Hh);
    g.textBaseline = 'middle';
    const v = V();
    const rulerH = rows[0].h;
    // Hatched outside (the scene timeline's pad around its scene).
    for (const [a, b] of cfg.shade?.() || []) {
      if (b < v0 || a > v1) continue;
      const x = Math.max(0, xOf(a)), x2 = Math.min(W, xOf(b));
      g.save(); g.beginPath(); g.rect(x, rulerH, x2 - x, Hh - rulerH); g.clip();
      g.fillStyle = col.shade; g.fillRect(x, rulerH, x2 - x, Hh - rulerH);
      g.strokeStyle = col.shadeLine; g.lineWidth = 1;
      for (let k = x - Hh; k < x2; k += 7) { g.beginPath(); g.moveTo(k, Hh); g.lineTo(k + Hh, rulerH); g.stroke(); }
      g.restore();
    }
    for (const r of rows) {
      if (r.ruler) { drawRuler(g, r); continue; }
      // Lane separators, a tint for a hidden or locked lane.
      g.fillStyle = col.line3; g.fillRect(0, r.y, W, 1);
      if (r.hidden || r.locked) { g.fillStyle = r.locked ? col.veilLock : col.veilHide; g.fillRect(0, r.y + 1, W, r.h - 1); }
      g.save(); g.beginPath(); g.rect(0, r.y, W, r.h); g.clip();
      g.globalAlpha = r.hidden ? 0.45 : 1;
      g.font = `500 11px ${col.font}`;
      r.draw?.(g, r, v);
      g.restore();
    }
    // Faint veil over removed parts (the locked cut).
    for (const [a, b] of cfg.veil?.() || []) {
      if (b < v0 || a > v1) continue;
      const x = Math.max(0, xOf(a)), x2 = Math.min(W, xOf(b));
      g.fillStyle = col.veil; g.fillRect(x, rulerH, Math.max(1, x2 - x), Hh - rulerH);
    }
    // The I–O range.
    if (io.a != null || io.b != null) {
      const a = io.a ?? lo, b = io.b ?? hi, x = Math.max(-2, xOf(a)), x2 = Math.min(W + 2, xOf(b));
      if (x2 > 0 && x < W) { g.fillStyle = alpha(col.sel, 0.07); g.fillRect(x, rulerH, x2 - x, Hh - rulerH); g.fillStyle = alpha(col.sel, 0.18); g.fillRect(x, rulerH - 5, x2 - x, 5); }
      g.fillStyle = col.sel;
      if (io.a != null) { const xa = Math.round(xOf(io.a)); g.fillRect(xa - 1, 0, 2, Hh); g.fillRect(xa, rulerH - 8, 6, 2); }
      if (io.b != null) { const xb = Math.round(xOf(io.b)); g.fillRect(xb - 1, 0, 2, Hh); g.fillRect(xb - 6, rulerH - 8, 6, 2); }
    }
    // Guides (a scene's edges).
    for (const gd of cfg.guides?.() || []) {
      const tt = drag?.kind === 'guide' && drag.g.id === gd.id ? drag.t : gd.t;
      if (tt < v0 || tt > v1) continue;
      const x = Math.round(xOf(tt));
      g.fillStyle = gd.waiting ? col.accent : col.text; g.fillRect(x - 1, rulerH, 2, Hh - rulerH);
    }
    if (cfg.overlay) { g.save(); cfg.overlay(g, v, rulerH, Hh); g.restore(); }
    // Marquee.
    if (drag?.kind === 'marquee' && drag.moved) {
      const x = Math.min(drag.x0, drag.x1), y = Math.min(drag.y0, drag.y1), w = Math.abs(drag.x1 - drag.x0), hh = Math.abs(drag.y1 - drag.y0);
      g.fillStyle = alpha(col.sel, 0.08); g.fillRect(x, y, w, hh);
      g.strokeStyle = col.sel; g.lineWidth = 1; g.setLineDash([4, 3]); g.strokeRect(x + 0.5, y + 0.5, w, hh); g.setLineDash([]);
    }
    // Snap line and its label.
    const sl = drag?.snapLine;
    if (sl && (drag.kind === 'move' || drag.kind === 'trim' || drag.kind === 'guide' || drag.kind === 'band')) {
      const x = Math.round(xOf(sl.t)) + 0.5;
      g.strokeStyle = col.accent; g.lineWidth = 1.5; g.setLineDash([4, 3]); g.beginPath(); g.moveTo(x, rulerH); g.lineTo(x, Hh); g.stroke(); g.setLineDash([]);
      g.font = `600 10.5px ${col.font}`;
      const w = g.measureText(sl.text).width + 14, lx = x + 6 + w > W ? x - 6 - w : x + 6;
      g.fillStyle = col.text; g.beginPath(); g.roundRect(lx, rulerH + 3, w, 18, 5); g.fill();
      g.fillStyle = col.inverse; g.fillText(sl.text, lx + 7, rulerH + 12.5);
    }
    // Playhead with its time.
    const px = Math.round(xOf(t));
    if (px >= -1 && px <= W + 1) {
      g.fillStyle = col.playhead;
      g.fillRect(px - 1, 0, 2, Hh);
      g.beginPath(); g.roundRect(px - 6, 0, 12, 11, [2, 2, 6, 6]); g.fill();
      g.font = `600 10px ${col.mono}`;
      const lab = c2(shownT(t)), w = g.measureText(lab).width + 10, lx = px + 8 + w > W ? px - 8 - w : px + 8;
      g.beginPath(); g.roundRect(lx, 2, w, 15, 4); g.fill();
      g.fillStyle = col.playheadInk; g.fillText(lab, lx + 5, 10);
    }
  }
  function drawRuler(g, r) {
    const step = tickStep(), [lo, hi] = bounds();
    g.fillStyle = col.panel; g.fillRect(0, r.y, W, r.h);
    g.fillStyle = col.line; g.fillRect(0, r.y + r.h - 1, W, 1);
    g.fillStyle = col.muted; g.font = `500 10px ${col.font}`;
    const minor = step / (step >= 1 && step % 5 === 0 ? 5 : step >= 1 ? 4 : 2);
    // On the cut's clock (clockMap) the ticks are round cut times, placed where the take plays them: none where the
    // cut removes the take. Nothing before 0:00 (a scene timeline's lead-in before the first scene).
    const m = clockMap(), from = Math.max(lo, v0, 0), to = Math.min(hi, v1);
    const c0 = m ? m.toCut(from) : from, c1 = m ? m.toCut(to) : to, at = (c) => xOf(m ? m.toSource(c) : c);
    g.fillStyle = col.line2;
    for (let c = Math.ceil(c0 / minor - 1e-6) * minor; c <= c1 + 1e-6; c += minor) g.fillRect(Math.round(at(c)), r.y + r.h - 4, 1, 3);
    g.fillStyle = col.muted;
    for (let c = Math.ceil(c0 / step - 1e-6) * step; c <= c1 + 1e-6; c += step) {
      const x = Math.round(at(c)) + 0.5;
      g.fillRect(x - 0.5, r.y + r.h - 7, 1, 6);
      g.fillText(tlabel(c, step), x + 4, r.y + r.h / 2 - 2);
    }
  }

  function metrics() {
    const head = q('.tk-head')?.offsetHeight || 36, sub = root.querySelector('.tk-sub');
    return { head, sub: sub && !sub.hidden ? sub.offsetHeight : 0, lanes: rows.map((r) => ({ k: r.k, h: r.h })) };
  }

  const api = {
    root, draw, fit, show, zoomAt, xOf: (t) => xOf(t), tOf: (x) => tOf(x), rows: () => rows.map((r) => ({ k: r.k, y: r.y, h: r.h })),
    redraw: () => { last = ''; },
    refit: () => { fitted = false; last = ''; },
    select: (ids) => setSel(ids, false), selection: () => selItems(),
    flags: (k) => ({ hide: flagOn(k, 'hide'), mute: flagOn(k, 'mute'), lock: flagOn(k, 'lock') }),
    range: () => ({ ...io }), view: () => [v0, v1], metrics, dragging: () => Boolean(drag),
    destroy: () => { ro.disconnect(); document.removeEventListener('keydown', onKey); stopShuttle(); closeHelp(); },
  };
  host.__track = api; // for the console and tests
  return api;
}

// ---------- drawing helpers the lanes share ----------
// A diamond (keys ◆, motion markers ◇).
export function diamond(g, x, y, r, fill, stroke, lw = 1.5) {
  g.beginPath(); g.moveTo(x, y - r); g.lineTo(x + r, y); g.lineTo(x, y + r); g.lineTo(x - r, y); g.closePath();
  if (fill) { g.fillStyle = fill; g.fill(); }
  if (stroke) { g.strokeStyle = stroke; g.lineWidth = lw; g.stroke(); }
}
// The voice waveform over a time range, as 1.5 px bars every 2 px.
export function wave(g, r, v, pk, color, { dim, gain = 1.15, pad = 6 } = {}) {
  const mid = r.y + r.h / 2;
  if (!pk?.data?.length) { g.fillStyle = color; g.fillRect(0, mid, v.W, 1); return; }
  g.fillStyle = color;
  const per = (v.v1 - v.v0) / Math.max(1, v.W);
  for (let x = 0; x < v.W; x += 2) {
    const ta = v.v0 + x * per, a = Math.floor(ta * pk.rate), b = Math.max(a + 1, Math.floor((ta + 2 * per) * pk.rate));
    let m = 0;
    for (let i = Math.max(0, a); i < Math.min(pk.data.length, b); i++) if (pk.data[i] > m) m = pk.data[i];
    const hh = Math.max(1, Math.min(1, Math.sqrt(m / 100) * gain) * (r.h - pad));
    g.globalAlpha = dim && dim(ta) ? 0.35 : 1;
    g.fillRect(x, mid - hh / 2, 1.5, hh);
  }
  g.globalAlpha = 1;
}
// The first index whose word ends after t (words sorted by start); lets long takes draw only what's in view.
export function firstWord(words, t) {
  let lo = 0, hi = words.length;
  while (lo < hi) { const m = (lo + hi) >> 1; if (words[m][1] < t) lo = m + 1; else hi = m; }
  return Math.max(0, lo - 1);
}
