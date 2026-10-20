// Shots in the editor: the Shots lane on the canvas timeline, the "/"
// breaks on the Words lane and in the Cut tab, the transition popover (Cut, Crossfade, Slide ← → ↑, Zoom), Claude's
// proposals (dashed, Keep it · No thanks on each), renaming,
// keyboard access, and every edit through the routes (POST /api/projects/<id>/shots, server/shots.mjs) with undo from
// their before / after. The data and the ops are web/shots.js; how the canvas edits and draws a shot is
// web/shotlook.js and web/app.js.
//
// makeShots({ id, getP, history, blocksView }) → the controller (blocksView: the band's view of blocks.json, for the
// section a shot is in). The canvas binds itself (bind) with what the lane needs from it:
//   { time(), seek(t), playing(), duration(), base(), scope() 'shot'|'all', editIndex(), pick(i) (a shot clicked: edit
//     it), flush() → Promise (save the canvas's unsaved shot changes first), changed({ layout, fromCanvas }) (the doc or
//     the video's look changed: redraw and re-read the shot being edited) }.
// The timeline attaches its track (attach) and draws lane / words / overlay; the Cut tab's panel sets cutPost and
// passes the editor's studio:shot-* messages to fromCut.
import { $, h, esc, api, toast } from './ui.js';
import { tokens, lookKey } from './tlcore.js';
import { effectiveLook, shotAt, TRANSITION_DUR, TRANSITION_MIN, TRANSITION_MAX, PRESETS, SLIDE_DIRS } from './layout.js';
import { glyphOf, mmss, trName, caretWord, hiddenOf, pruneToBase } from './shotlook.js';
import { syncPropActs } from './zoomsui.js';

const PENCIL = '<svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true"><path d="M8 1.8l2.2 2.2-6 6H2V7.8z" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"/></svg>';
export const SHOT_ICON = { pencil: PENCIL };
const same = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

export function makeShots({ id, getP, history, blocksView = () => null }) {
  const url = `/api/projects/${encodeURIComponent(id)}/shots`;
  let doc = null, C = null, track = null, wordsOf = () => [], cutOf = () => null;
  let selBrk = null, ver = 0, opAt = 0, inFlight = 0;
  let drag = null, wdrag = null, pop = null, popFor = null, ren = null, keys = null, keyBtns = new Map(), keySig = '';
  let acts = null, actMap = new Map();
  let toastT = 0;
  let cutPost = null, picked = () => {};
  const pickBrk = (sid) => { selBrk = sid; bump(); if (sid) picked(); };

  const list = () => (doc?.shots?.length ? doc.shots : [{ id: 's1', start: 0 }]);
  const dur = () => C?.duration?.() || 0;
  const endOf = (L, i) => (i + 1 < L.length ? L[i + 1].start : Math.max(dur(), L[i].start + 0.5));
  const bump = () => { ver++; };
  const baseLook = () => C?.base?.() || null;
  const lookOf = (i) => { const b = baseLook(); return b ? effectiveLook(b, list()[i]?.look || null) : null; };
  const label = (i) => { const s = list()[i]; return `Shot ${i + 1}${s?.name ? ` · ${s.name}` : ''}`; };

  // ---------- the doc ----------
  // A project refresh brings the file as the server has it; right after an edit it may still be the one from before.
  function update() {
    const d = getP().shots;
    if (!d || !Array.isArray(d.shots) || inFlight || Date.now() - opAt < 1200 || same(d, doc)) return;
    doc = d; bump();
    if (selBrk && !list().some((s) => s.id === selBrk)) selBrk = null;
    C?.changed?.({});
    sendCut();
  }
  // The section a moment is in ("in Main body"), from the band's view of blocks.json (none before Split into sections).
  const sectionAt = (t) => {
    const v = blocksView();
    if (!v?.marked) return null;
    return (v.items || []).find((x) => x.kind === 'take' && x.source?.take && t >= x.source.take[0] - 1e-3 && t < x.source.take[1])?.label || null;
  };

  // ---------- edits: one or more ops, one undo step ----------
  async function restore(d, layout) {
    const r = await api(url, { op: 'restore', doc: d, ...(layout ? { layout } : {}) });
    doc = r.shots; opAt = Date.now(); bump();
    C?.changed?.({ layout: r.layout || null });
    sendCut();
  }
  // chain(bodies, { label, quiet, fromCanvas }) → the last result, or null (with a toast) when an op is refused.
  async function chain(bodies, { label: what = 'Shots', quiet = false, fromCanvas = false } = {}) {
    if (!fromCanvas) await C?.flush?.();
    inFlight++;
    let first = null, last = null;
    try {
      for (const b of bodies) { const r = await api(url, b); first ||= r; last = r; }
    } catch (e) { toast(e.message); }
    finally { inFlight--; }
    if (!last) return null;
    doc = last.shots; opAt = Date.now(); bump();
    if (selBrk && !list().some((s) => s.id === selBrk)) selBrk = null;
    const before = first.before, after = last.after, lb = first.layoutBefore || null, la = last.layout || null;
    history?.push({ label: what, undo: () => restore(before, lb), redo: () => restore(after, la) });
    C?.changed?.({ layout: la, fromCanvas });
    sendCut();
    if (!quiet && last.note) toast(last.note);
    return last;
  }
  const op = (b, o) => chain([b], o);

  // S at the playhead (snaps to a word start or a pause), "/" before the word at the caret, Delete on a break.
  async function split(t) {
    const L = list(), s = shotAt(t, L);
    const r = await op({ op: 'split', t, id: s?.shot.id }, { label: 'Split a shot' });
    if (r?.id) C?.pick?.(null);
    return r;
  }
  async function slash(t) {
    const w = caretWord(t, wordsOf(), cutOf());
    if (w == null) { toast('Put the playhead before a word: the new shot starts at the word after it.'); return null; }
    const r = await op({ op: 'add', word: w }, { label: 'New shot (/)' });
    if (r?.id) C?.pick?.(null); // a shot the creator made: the inspector edits it ("This shot")
    return r;
  }
  const addAt = async (t) => { const r = await op({ op: 'add', t }, { label: 'New shot (/)' }); if (r?.id) C?.pick?.(null); return r; };
  async function merge(sid) {
    const L = list(), i = L.findIndex((s) => s.id === sid);
    if (i < 1) return null;
    if (L[i].section) { toast(`That break is where a section starts (${sectionAt(L[i].start) || 'a section'}): a section edge is always a shot edge. Join the sections on the Sections band to remove it.`); return null; }
    selBrk = null; closePop();
    return op({ op: 'merge', id: sid }, { label: `Merge ${label(i)}` });
  }
  const moveBreak = (sid, where) => op({ op: 'move', id: sid, ...where }, { label: 'Move a shot break' });
  const setTransition = (sid, tin, all = false) => op(all ? { op: 'transition', all: true, in: tin } : { op: 'transition', id: sid, in: tin }, { label: all ? 'Every shot change' : 'Transition', quiet: false });
  const rename = (sid, name) => op({ op: 'name', id: sid, name }, { label: 'Rename a shot', quiet: true });
  // Claude's proposals: Keep it (it becomes the creator's) or No thanks (back to "was", or gone).
  const keep = (ids) => op({ op: 'keep', ...(ids === 'all' ? { all: true } : { ids }) }, { label: 'Keep a proposed shot' });
  const reject = (ids) => op({ op: 'reject', ...(ids === 'all' ? { all: true } : { ids }) }, { label: 'Turn down a proposed shot' });

  // ---------- colours (the look's tokens; the tiny layout pictures are the video's own colours) ----------
  let pal = null, palKey = '';
  function colors() {
    const k = lookKey();
    if (pal && palKey === k) return pal;
    const g = tokens();
    pal = { panel: g('--pop-bg', g('--panel', '#ffffff')), panel2: g('--panel-2', '#fafaf8'), panel3: g('--panel-3', '#f0efec'), line: g('--line', '#e6e5e1'), line2: g('--line-2', '#dcdbd6'),
      text: g('--text', '#1a1a1c'), text2: g('--text-2', '#33333a'), muted: g('--muted', '#55555a'), faint: g('--faint', '#6f6f74'),
      sel: g('--sel', '#2563eb'), selSoft: g('--sel-soft', '#dce7fd'), selInk: g('--sel-ink', '#ffffff'), accent: g('--accent', '#c2410c'), accentText: g('--accent-text', '#9a3412'),
      accentLine: g('--accent-line', '#c2410c40'), accentSoft: g('--accent-soft', '#c2410c14'), font: g('--font', 'system-ui'), mono: g('--mono', 'ui-monospace, monospace') };
    palKey = k;
    return pal;
  }

  // ---------- the Shots lane ----------
  const fit = (g, s, w) => { if (g.measureText(s).width <= w) return s; let t = s; while (t.length > 1 && g.measureText(`${t}…`).width > w) t = t.slice(0, -1); return t.length > 1 ? `${t}…` : ''; };
  // The tiny picture of a layout (24 × 14): screen light, camera dark with a head; an accent dot when this shot hides
  // the camera.
  function glyph(g, x, y, gl, hid) {
    const scr = '#e9e8e4', cam = '#5c5c62';
    g.fillStyle = '#2a2a2e'; g.beginPath(); g.roundRect(x, y, 24, 14, 3); g.fill();
    const flip = gl.side === 'left';
    const R = (rx, ry, rw, rh, c) => { g.fillStyle = c; g.beginPath(); g.roundRect(flip ? x + 24 - (rx - x) - rw : rx, ry, rw, rh, 1); g.fill(); };
    const head = (cx, cy) => { g.fillStyle = scr; g.beginPath(); g.arc(flip ? x + 24 - (cx - x) : cx, cy, 2, 0, Math.PI * 2); g.fill(); };
    const p = gl.preset;
    if (p === 'camera') { if (gl.cam) { R(x + 2, y + 2, 20, 10, cam); head(x + 12, y + 5.5); } }
    else if (p === 'screen') { if (gl.screen) R(x + 2, y + 2, 20, 10, scr); }
    else if (p === 'pip') {
      if (gl.screen) R(x + 2, y + 2, 20, 10, scr);
      if (gl.cam) { R(x + 14, y + 6, 8, 6, '#ffffff'); R(x + 15, y + 7, 6, 4, cam); }
    } else {
      const top = p === 'boxed' ? 3 : 2, hh = 14 - 2 * top;
      if (gl.screen) R(x + 2, y + top, 13, hh, scr);
      if (gl.cam) { R(x + 16, y + top, 6, hh, cam); head(x + 19, y + top + 2.5); }
    }
    if (hid) { const c = colors(); g.fillStyle = c.accent; g.strokeStyle = '#2a2a2e'; g.lineWidth = 1.5; g.beginPath(); g.arc(x + 20, y + 4, 3.5, 0, Math.PI * 2); g.fill(); g.stroke(); }
  }
  // The mark on a break: a plain line for a cut, a round mark for anything else (its icon: a crossfade's two squares, a
  // slide's arrow, a zoom's square in a square); ringed when selected.
  function mark(g, x, cy, hh, s, on) {
    const c = colors();
    g.save();
    if (!s.in) {
      g.fillStyle = on ? c.selSoft : c.panel; g.strokeStyle = on ? c.sel : c.line2; g.lineWidth = on ? 2 : 1;
      g.beginPath(); g.roundRect(x - 5, cy - hh / 2, 10, hh, 4); g.fill(); g.stroke();
      g.fillStyle = on ? c.sel : c.faint; g.fillRect(x - 0.75, cy - hh / 2 + 5, 1.5, hh - 10);
    } else {
      g.fillStyle = on ? c.selSoft : c.panel; g.strokeStyle = on ? c.sel : c.accentLine; g.lineWidth = on ? 2 : 1.25;
      g.beginPath(); g.arc(x, cy, 9.5, 0, Math.PI * 2); g.fill(); g.stroke();
      g.fillStyle = on ? c.sel : c.accentText; g.strokeStyle = on ? c.sel : c.accentText; g.lineWidth = 1.2;
      if (s.in.type === 'slide') {
        // an arrow the way the next shot moves in
        const a = { left: Math.PI, right: 0, up: -Math.PI / 2 }[s.in.dir] ?? Math.PI;
        g.save(); g.translate(x, cy); g.rotate(a);
        g.beginPath(); g.moveTo(-5, 0); g.lineTo(4.5, 0); g.moveTo(1, -3.5); g.lineTo(4.5, 0); g.lineTo(1, 3.5); g.lineWidth = 1.5; g.stroke(); g.restore();
      } else if (s.in.type === 'zoom') {
        g.beginPath(); g.roundRect(x - 5.5, cy - 5.5, 11, 11, 1.5); g.stroke();
        g.globalAlpha = 0.5; g.beginPath(); g.roundRect(x - 2.5, cy - 2.5, 5, 5, 1); g.fill(); g.globalAlpha = 1;
      } else {
        // the crossfade icon: a filled square under an outlined one
        g.globalAlpha = 0.4; g.beginPath(); g.roundRect(x - 5, cy - 5, 6, 6, 1); g.fill(); g.globalAlpha = 1;
        g.beginPath(); g.roundRect(x - 1.5, cy - 1.5, 6.5, 6.5, 1); g.stroke();
      }
    }
    g.restore();
  }
  const startOf = (L, i) => (drag && drag.moved && !drag.fixed && drag.id === L[i].id ? drag.t : wdrag && wdrag.moved && wdrag.id === L[i].id && wdrag.t != null ? wdrag.t : L[i].start);
  function drawLane(g, r, v) {
    const c = colors(), L = list(), on = C?.scope?.() === 'shot' ? C.editIndex() : -1, b = baseLook();
    const baseHid = new Set(hiddenOf(b));
    const y = r.y + 4, hh = r.h - 8, cy = y + hh / 2;
    g.save();
    g.textBaseline = 'middle';
    for (let i = 0; i < L.length; i++) {
      const a = startOf(L, i), e = i + 1 < L.length ? startOf(L, i + 1) : endOf(L, i);
      if (e < v.v0 || a > v.v1) continue;
      const x = Math.max(-10, v.xOf(a)) + (i ? 1.5 : 0.5), x2 = Math.min(v.W + 10, v.xOf(e)) - 1.5, w = x2 - x;
      if (w < 2) continue;
      const s = L[i], sel = i === on, prop = s.status === 'proposed';
      g.beginPath(); g.roundRect(x, y, w, hh, Math.min(7, w / 2));
      if (sel || !prop) { g.fillStyle = sel ? c.selSoft : c.panel2; g.fill(); }
      g.strokeStyle = sel ? c.sel : c.line2; g.lineWidth = sel ? 1.5 : 1;
      if (prop) g.setLineDash([4, 3]);
      g.stroke(); g.setLineDash([]);
      g.save(); g.beginPath(); g.rect(x + 2, y, w - 4, hh); g.clip();
      let cx = x + (i ? 13 : 8);
      const lk = lookOf(i);
      if (lk && w > 58) { const gl = glyphOf(lk); glyph(g, cx, cy - 7, gl, !gl.cam && !baseHid.has('cam') && (s.look?.hidden || []).includes('cam')); cx += 30; }
      g.font = `600 11px ${c.font}`;
      const n = String(i + 1), nw = Math.max(16, g.measureText(n).width + 8);
      if (cx + nw <= x2 - 3) {
        g.fillStyle = sel ? c.sel : c.panel3; g.beginPath(); g.roundRect(cx, cy - 8, nw, 16, 5); g.fill();
        g.fillStyle = sel ? c.selInk : c.text; g.textAlign = 'center'; g.fillText(n, cx + nw / 2, cy + 0.5); g.textAlign = 'left';
        cx += nw + 6;
      }
      if (s.name && cx < x2 - 14) { g.font = `${sel ? 600 : 500} 12px ${c.font}`; g.fillStyle = sel ? c.text : c.text2; g.fillText(fit(g, s.name, x2 - 8 - cx), cx, cy + 0.5); }
      g.restore();
      if (sel && s.look && w > 24) { g.fillStyle = c.accent; g.beginPath(); g.arc(x2 - 6, y + 5.5, 3, 0, Math.PI * 2); g.fill(); }
    }
    for (let i = 1; i < L.length; i++) {
      const t = startOf(L, i);
      if (t < v.v0 - 1 || t > v.v1 + 1) continue;
      mark(g, Math.round(v.xOf(t)), cy, hh + 2, L[i], L[i].id === selBrk);
    }
    g.restore();
  }
  function laneHit(p, r, v) {
    const L = list(), cy = r.y + r.h / 2;
    let best = null;
    for (let i = 1; i < L.length; i++) {
      const d = Math.abs(v.xOf(L[i].start) - p.x), reach = L[i].in ? 11 : 7;
      if (d <= reach && (!best || d < best.d)) best = { kind: 'brk', i, id: L[i].id, d, onMark: Math.abs(p.y - cy) <= 11 };
    }
    if (best) return best;
    const t = v.tOf(p.x), s = shotAt(t, L);
    return s && t <= endOf(L, s.index) ? { kind: 'shot', i: s.index, id: s.shot.id } : null;
  }
  const canvasEl = () => track?.root.querySelector('.tk-canvas');
  // A point on the lane canvas → the page.
  const pageAt = (x, y) => { const b = canvasEl()?.getBoundingClientRect(); return b ? { x: b.left + x, y: b.top + y } : { x, y }; };
  const sectionNote = (s) => { const n = sectionAt(s.start); return n ? `the section “${n}” starts` : 'a section starts'; };

  const lane = {
    label: 'Shots', height: 36,
    on: () => true,
    sig: () => `${ver}|${selBrk}|${drag ? `${drag.moved}:${drag.t?.toFixed(3)}` : ''}|${wdrag ? `${wdrag.moved}:${wdrag.t}` : ''}|${C?.scope?.()}|${C?.scope?.() === 'shot' ? C.editIndex() : ''}|${palKey}`,
    draw: (g, r, v) => drawLane(g, r, v),
    down(p, r, v) {
      const hit = laneHit(p, r, v);
      if (!hit) return false;
      closePop();
      if (hit.kind === 'brk') {
        const s = list()[hit.i];
        pickBrk(hit.id);
        drag = { id: hit.id, i: hit.i, x0: p.x, t: s.start, moved: false, onMark: hit.onMark, fixed: Boolean(s.section), y: r.y + r.h / 2 };
        return true;
      }
      // A shot: it's the one you edit now (the timeline moves the playhead to the click).
      if (selBrk) { selBrk = null; bump(); }
      C?.pick?.(hit.i);
      return false;
    },
    move(p, r, v, e) {
      if (!drag) return;
      if (Math.abs(p.x - drag.x0) > 3) drag.moved = true;
      if (!drag.moved || drag.fixed) return;
      const L = list(), lo = L[drag.i - 1].start + 0.05, hi = drag.i + 1 < L.length ? L[drag.i + 1].start - 0.05 : Math.max(lo, dur() - 0.05);
      const cl = (t) => Math.min(hi, Math.max(lo, t));
      drag.t = cl(v.snap ? v.snap(cl(v.tOf(p.x)), e) : v.tOf(p.x));
    },
    async up() {
      const d = drag;
      drag = null; bump();
      if (!d) return;
      if (d.moved) {
        if (d.fixed) { toast(`This break is where ${sectionNote(list()[d.i])}: it moves with the section's edge on the Sections band.`); return; }
        await moveBreak(d.id, { t: Math.round(d.t * 1000) / 1000 });
        return;
      }
      if (d.onMark) openPop(d.id, pageAt(track.xOf(list()[d.i].start), d.y + 12));
    },
    hover(p, r, v) {
      if (drag) return { cursor: drag.fixed ? 'not-allowed' : 'ew-resize' };
      const hit = laneHit(p, r, v);
      if (!hit) return { cursor: '', title: '' };
      const L = list();
      if (hit.kind === 'brk') {
        const s = L[hit.i];
        return { cursor: hit.onMark ? 'pointer' : s.section ? 'default' : 'ew-resize',
          title: `Shot ${hit.i + 1} comes in with: ${trName(s.in)}${s.section ? ` · ${sectionNote(s)}` : ''}\nClick the mark to change it · select and press Delete to merge${s.section ? '' : ' · drag to move it'}` };
      }
      const s = L[hit.i], lk = lookOf(hit.i), gl = lk && glyphOf(lk);
      return { cursor: 'pointer', title: `${label(hit.i)} · ${mmss(s.start)}–${mmss(endOf(L, hit.i))}${gl ? ` · ${PRESETS[gl.preset] || gl.preset}${gl.cam ? '' : ', no camera'}` : ''}${s.status === 'proposed' ? '\nProposed by Claude: click to see it in the picture, then Keep it or No thanks' : ''}\nClick to edit this shot · double-click to rename it` };
    },
    dbl(p, r, v) {
      const hit = laneHit(p, r, v);
      if (hit?.kind === 'shot') renameBox(hit.i);
    },
  };

  // The stretch of the shot being edited, tinted across every lane (under the playhead).
  function overlay(g, v, top, H) {
    if (C?.scope?.() !== 'shot') return;
    const L = list(), i = C.editIndex(), a = L[i] ? startOf(L, i) : 0, e = i + 1 < L.length ? startOf(L, i + 1) : endOf(L, i);
    if (e < v.v0 || a > v.v1) return;
    const c = colors(), x = Math.max(0, v.xOf(a)), x2 = Math.min(v.W, v.xOf(e));
    g.fillStyle = v.col.a(c.sel, 0.06); g.fillRect(x, top, x2 - x, H - top);
    g.strokeStyle = v.col.a(c.sel, 0.6); g.lineWidth = 1; g.setLineDash([3, 3]);
    g.beginPath();
    if (a >= v.v0) { g.moveTo(Math.round(x) + 0.5, top); g.lineTo(Math.round(x) + 0.5, H); }
    if (e <= v.v1) { g.moveTo(Math.round(x2) - 0.5, top); g.lineTo(Math.round(x2) - 0.5, H); }
    g.stroke(); g.setLineDash([]);
  }

  // ---------- "/" on the Words lane ----------
  function drawSlashes(g, r, v) {
    const c = colors(), L = list();
    g.save();
    g.textBaseline = 'middle'; g.textAlign = 'center';
    for (let i = 1; i < L.length; i++) {
      const t = startOf(L, i);
      if (t < v.v0 - 1 || t > v.v1 + 1) continue;
      const x = Math.round(v.xOf(t)), on = L[i].id === selBrk, cy = r.y + r.h / 2;
      if (on) { g.fillStyle = c.selSoft; g.strokeStyle = c.sel; g.lineWidth = 1.5; g.beginPath(); g.roundRect(x - 7, r.y + 2, 14, r.h - 4, 4); g.fill(); g.stroke(); }
      else { g.fillStyle = c.panel; g.beginPath(); g.roundRect(x - 5, r.y + 3, 10, r.h - 6, 3); g.fill(); }
      g.font = `700 15px ${c.mono}`; g.fillStyle = on ? c.sel : c.accent;
      g.fillText('/', x, cy + 1);
    }
    if (wdrag?.moved && wdrag.t != null) { const x = Math.round(v.xOf(wdrag.t)); g.fillStyle = c.sel; g.fillRect(x - 1, r.y + 1, 2, r.h - 2); }
    g.restore();
  }
  function slashHit(p, r, v) {
    const L = list();
    let best = null;
    for (let i = 1; i < L.length; i++) { const d = Math.abs(v.xOf(L[i].start) - p.x); if (d <= 7 && (!best || d < best.d)) best = { i, id: L[i].id, d }; }
    return best;
  }
  // The word start nearest a time (the "/" lands before a word).
  function nearestWord(t) {
    const W = wordsOf(), cut = cutOf();
    let best = null;
    W.forEach((w, i) => { if (cut?.length && !cut.some(([a, b]) => (w[0] + w[1]) / 2 >= a && (w[0] + w[1]) / 2 < b)) return; const d = Math.abs(w[0] - t); if (!best || d < best.d) best = { i, d, t: w[0] }; });
    return best;
  }
  const words = {
    draw: drawSlashes,
    down(p, r, v) {
      const hit = slashHit(p, r, v);
      if (!hit) return false;
      closePop();
      pickBrk(hit.id);
      wdrag = { id: hit.id, i: hit.i, x0: p.x, moved: false, t: null, word: null, y: r.y + r.h };
      return true;
    },
    move(p, r, v) {
      if (!wdrag) return;
      if (Math.abs(p.x - wdrag.x0) > 3) wdrag.moved = true;
      if (!wdrag.moved) return;
      const nw = nearestWord(v.tOf(p.x));
      if (nw) { wdrag.t = nw.t; wdrag.word = nw.i; }
    },
    async up() {
      const d = wdrag;
      wdrag = null; bump();
      if (!d) return;
      const s = list()[d.i];
      if (d.moved) {
        if (s?.section) { toast(`This break is where ${sectionNote(s)}: it moves with the section's edge on the Sections band.`); return; }
        if (d.word != null) await moveBreak(d.id, { word: d.word });
        return;
      }
      openPop(d.id, pageAt(track.xOf(s.start), d.y + 4));
    },
    hover(p, r, v) {
      if (wdrag) return { cursor: 'grabbing' };
      const hit = slashHit(p, r, v);
      if (!hit) return null;
      const s = list()[hit.i];
      return { cursor: 'grab', title: `“/” Shot ${hit.i + 1} starts here · ${trName(s.in)}\nClick: how it comes in · drag to another word · Delete merges it into Shot ${hit.i}` };
    },
  };

  // ---------- the transition popover: Cut, Crossfade, Slide (← → ↑), Zoom; the length; every shot change ----------
  function closePop(restoreFocus = false) {
    if (!pop) return;
    const back = pop.__opener;
    pop.remove(); pop = null; popFor = null;
    document.removeEventListener('pointerdown', outside, true);
    document.removeEventListener('keydown', popKey, true);
    if (restoreFocus && back?.isConnected) back.focus();
  }
  const outside = (e) => { if (pop && !pop.contains(e.target)) closePop(); };
  const popKey = (e) => { if (e.key === 'Escape' && pop) { e.preventDefault(); e.stopPropagation(); closePop(true); } };
  const trd = (k) => `<span class="trd ${k}" aria-hidden="true"><i></i><b></b></span>`;
  function openPop(sid, at, { focus = false } = {}) {
    const opener = focus ? document.activeElement : null;
    closePop();
    const L = list(), i = L.findIndex((s) => s.id === sid);
    if (i < 1) return;
    const s = L[i], tin = s.in || null, type = tin?.type || 'cut', len = tin?.dur ?? TRANSITION_DUR.fade;
    const allSame = L.length > 2 && L.slice(1).every((x) => same(x.in || null, tin));
    const tile = (k, name) => { const on = k === type; return `<button type="button" role="radio" aria-checked="${on}" class="shp-t${on ? ' on' : ''}" data-t="${k}">${trd(k)}<span>${name}</span></button>`; };
    const DIRS = { left: ['←', 'Slide left: the next shot comes in from the right'], right: ['→', 'Slide right: the next shot comes in from the left'], up: ['↑', 'Slide up: the next shot comes in from below'] };
    pop = h(`<div class="shp" role="dialog" aria-label="How Shot ${i + 1} comes in">
      <div class="shp-h"><b>Into ${esc(label(i))}</b><button type="button" class="shp-x" aria-label="Close">×</button></div>
      <div class="shp-trs" role="radiogroup" aria-label="Transition">${tile('cut', 'Cut')}${tile('fade', 'Crossfade')}${tile('slide', 'Slide')}${tile('zoom', 'Zoom')}</div>
      <div class="row shp-dir"${type === 'slide' ? '' : ' hidden'}><span>Direction</span><div class="seg" role="radiogroup" aria-label="Slide direction">${SLIDE_DIRS.map((d) => `<button type="button" role="radio" data-d="${d}" aria-checked="${tin?.dir === d}" class="${tin?.dir === d ? 'on' : ''}" title="${DIRS[d][1]}" aria-label="${DIRS[d][1]}">${DIRS[d][0]}</button>`).join('')}</div></div>
      <label class="slider shp-len"${tin ? '' : ' hidden'}><span>Length</span><input type="range" min="${TRANSITION_MIN}" max="${TRANSITION_MAX}" step="0.05" value="${len}" aria-label="Length in seconds"><span class="val">${len.toFixed(2)} s</span></label>
      <button type="button" class="btn small shp-all"${allSame ? ' disabled' : ''}>${allSame ? '✓ Every shot change uses this' : 'Use for every shot change'}</button>
      ${s.section ? `<p class="sub shp-note">A section starts here too: ${esc(sectionAt(s.start) || 'a section')}.</p>` : ''}</div>`);
    pop.__opener = opener;
    pop.__at = at;
    document.body.append(pop);
    popFor = sid;
    const w = pop.offsetWidth, hh = pop.offsetHeight;
    pop.style.left = `${Math.round(Math.max(8, Math.min(innerWidth - w - 8, at.x - 28)))}px`;
    pop.style.top = `${Math.round(at.y + hh + 8 > innerHeight ? Math.max(8, at.y - hh - 30) : at.y + 6)}px`;
    const again = () => { const st = list().find((x) => x.id === sid); if (st && pop && popFor === sid) openPop(sid, at, { focus: pop.contains(document.activeElement) }); };
    pop.querySelector('.shp-x').onclick = () => closePop(true);
    pop.querySelectorAll('.shp-t').forEach((b) => (b.onclick = async () => {
      const k = b.dataset.t;
      if (k === type) return;
      // A new kind keeps the length the creator set, else takes its own default (crossfade 0.4 s, slide and zoom 0.5 s).
      const dur = tin && tin.dur !== TRANSITION_DUR[tin.type] ? tin.dur : TRANSITION_DUR[k];
      const r = await setTransition(sid, k === 'cut' ? null : { type: k, dur, ...(k === 'slide' ? { dir: tin?.dir || 'left' } : {}) });
      if (r) again();
    }));
    pop.querySelectorAll('.shp-dir [data-d]').forEach((b) => (b.onclick = async () => {
      if (!tin || tin.dir === b.dataset.d) return;
      const r = await setTransition(sid, { ...tin, dir: b.dataset.d });
      if (r) again();
    }));
    const rng = pop.querySelector('.shp-len input'), val = pop.querySelector('.shp-len .val');
    rng.oninput = () => { val.textContent = `${Number(rng.value).toFixed(2)} s`; };
    rng.onchange = async () => { const r = await setTransition(sid, { ...(tin || { type: 'fade' }), dur: Number(rng.value) }); if (r) again(); };
    pop.querySelector('.shp-all').onclick = async () => { const r = await setTransition(sid, tin, true); if (r) again(); };
    setTimeout(() => { document.addEventListener('pointerdown', outside, true); document.addEventListener('keydown', popKey, true); }, 0);
    if (focus) (pop.querySelector('.shp-t.on') || pop.querySelector('.shp-t'))?.focus();
  }

  // ---------- rename (double-click a shot on the lane, or Enter on it) ----------
  function renameBox(i) {
    if (!track) return;
    ren?.remove();
    const L = list(), s = L[i], row = track.rows().find((x) => x.k === 'shots');
    if (!s || !row) return;
    const lanes = track.root.querySelector('.tk-lanes');
    const x = Math.max(4, track.xOf(s.start) + 8), x2 = Math.min(lanes.clientWidth - 4, track.xOf(endOf(L, i)) - 6);
    const box = h(`<input class="field sh-ren" maxlength="60" spellcheck="false" aria-label="Name of shot ${i + 1}" placeholder="Shot ${i + 1}">`);
    box.value = s.name || '';
    box.style.left = `${Math.round(Math.min(x, lanes.clientWidth - 180))}px`;
    box.style.top = `${row.y + 5}px`;
    box.style.width = `${Math.round(Math.max(150, Math.min(280, x2 - x)))}px`;
    box.style.height = `${row.h - 10}px`;
    lanes.append(box);
    ren = box;
    let done = false;
    const finish = async (save) => {
      if (done) return;
      done = true; box.remove(); if (ren === box) ren = null;
      const n = box.value.trim();
      if (save && n !== (s.name || '')) await rename(s.id, n);
      keyBtns.get(`s:${s.id}`)?.focus();
    };
    box.onkeydown = (e) => { e.stopPropagation(); if (e.key === 'Enter') { e.preventDefault(); finish(true); } if (e.key === 'Escape') { e.preventDefault(); finish(false); } };
    box.onblur = () => finish(true);
    box.focus(); box.select();
  }

  // ---------- keyboard: shots and breaks as buttons over the lane (Tab to them) ----------
  // Transparent buttons laid over the canvas lane, so each shot and each break can take focus and has a name for a
  // screen reader; the mouse goes straight through to the canvas.
  function syncKeys() {
    if (!track || !keys) return;
    const row = track.rows().find((x) => x.k === 'shots');
    const [v0, v1] = track.view(), L = list();
    const sig = `${ver}|${v0.toFixed(3)}|${v1.toFixed(3)}|${row?.y}|${row?.h}|${track.root.querySelector('.tk-lanes')?.clientWidth}`;
    if (sig === keySig) return;
    keySig = sig;
    keys.hidden = !row;
    // Keep it · No thanks on each of Claude's proposed shots (on the lane, at the shot's right end).
    if (acts) syncPropActs(acts, actMap, !row ? [] : L.map((s, i) => ({ s, i })).filter(({ s, i }) => s.status === 'proposed' && endOf(L, i) >= v0 && s.start <= v1)
      .map(({ s, i }) => ({ key: s.id, x: Math.max(0, track.xOf(s.start)) + 10, x2: Math.min(track.xOf(v1), track.xOf(endOf(L, i))), y: row.y, h: row.h, name: label(i) })),
    (sid, a) => (a === 'keep' ? keep([sid]) : reject([sid])));
    if (!row) return;
    const want = new Map();
    L.forEach((s, i) => {
      const e = endOf(L, i);
      if (e < v0 || s.start > v1) return;
      const x = Math.max(0, track.xOf(s.start)), x2 = Math.min(track.xOf(v1), track.xOf(e));
      want.set(`s:${s.id}`, { i, s, kind: 'shot', x: x + 2, w: Math.max(6, x2 - x - 4), name: `${label(i)}, ${mmss(s.start)} to ${mmss(e)}` });
      if (i) want.set(`b:${s.id}`, { i, s, kind: 'brk', x: track.xOf(s.start) - 9, w: 18, name: `Break before shot ${i + 1}: ${trName(s.in)}${s.section ? ', a section starts here' : ''}` });
    });
    for (const [k, b] of keyBtns) if (!want.has(k)) { b.remove(); keyBtns.delete(k); }
    for (const [k, it] of want) {
      let b = keyBtns.get(k);
      if (!b) {
        b = document.createElement('button');
        b.type = 'button'; b.className = `sh-key ${it.kind}`;
        b.addEventListener('focus', () => onKeyFocus(b));
        b.addEventListener('keydown', (e) => onKeyDown(b, e));
        keyBtns.set(k, b); keys.append(b);
      }
      b.__it = it;
      b.setAttribute('aria-label', it.name);
      b.title = it.kind === 'brk' ? 'Enter: how the next shot comes in · Delete: merge · ← →: move by a word' : 'Enter: rename';
      b.style.cssText = `left:${Math.round(it.x)}px;top:${row.y + 3}px;width:${Math.round(it.w)}px;height:${row.h - 6}px`;
    }
    // keep the tab order left to right (only moving buttons when it changed: moving one takes its focus away)
    const order = [...want.keys()].sort((a, b) => want.get(a).x - want.get(b).x), now = [...keys.children];
    if (order.some((k, n) => now[n] !== keyBtns.get(k))) {
      const had = document.activeElement;
      order.forEach((k) => keys.append(keyBtns.get(k)));
      if (had && had !== document.activeElement && had.isConnected) had.focus({ preventScroll: true });
    }
  }
  function onKeyFocus(b) {
    const it = b.__it;
    if (!it) return;
    if (it.kind === 'brk') { pickBrk(it.s.id); return; }
    if (selBrk) { selBrk = null; bump(); }
    const t = C?.time?.() ?? 0, L = list(), e = endOf(L, it.i);
    if (t < it.s.start || t >= e) C?.seek?.(Math.min(e - 0.02, it.s.start + 0.02));
    C?.pick?.(it.i);
  }
  async function onKeyDown(b, e) {
    const it = b.__it;
    if (!it) return;
    const k = e.key;
    const stop = () => { e.preventDefault(); e.stopPropagation(); };
    if (k === 'Escape') { stop(); if (selBrk) { selBrk = null; bump(); } b.blur(); return; }
    if (it.kind === 'shot') {
      if (k === 'Enter' || k === 'F2') { stop(); renameBox(it.i); }
      else if (k === 'Delete' || k === 'Backspace') { stop(); toast('To merge two shots, Tab to the line between them and press Delete.'); }
      return;
    }
    if (k === 'Delete' || k === 'Backspace') { stop(); await merge(it.s.id); return; }
    if (k === 'Enter' || k === ' ') { stop(); const r = b.getBoundingClientRect(); openPop(it.s.id, { x: r.left + r.width / 2, y: r.bottom }, { focus: true }); return; }
    if (k === 'ArrowLeft' || k === 'ArrowRight') {
      stop();
      if (it.s.section) { toast(`This break is where ${sectionNote(it.s)}: it moves with the section's edge.`); return; }
      const W = wordsOf(), cut = cutOf(), cur = caretWord(it.s.start + 1e-3, W, cut);
      if (cur == null) return;
      let j = cur + (k === 'ArrowLeft' ? -1 : 1);
      const kept = (w) => !cut?.length || cut.some(([a, c]) => (w[0] + w[1]) / 2 >= a && (w[0] + w[1]) / 2 < c);
      while (W[j] && !kept(W[j])) j += k === 'ArrowLeft' ? -1 : 1;
      if (!W[j]) return;
      await moveBreak(it.s.id, { word: j });
      setTimeout(() => keyBtns.get(`b:${it.s.id}`)?.focus(), 50);
    }
  }

  // ---------- the toast with buttons ("Camera hidden in Shot 3 · Undo · Hide in all shots") ----------
  function actionToast(text, acts) {
    const t = $('#toast');
    if (!t) return;
    t.replaceChildren(h(`<span>${esc(text)}</span>`), ...acts.map(([name, fn]) => {
      const b = h(`<button type="button" class="toast-a">${esc(name)}</button>`);
      b.onclick = () => { t.hidden = true; fn(); };
      return b;
    }));
    t.hidden = false;
    clearTimeout(toastT);
    toastT = setTimeout(() => { if (t.querySelector('.toast-a')) t.hidden = true; }, 7000);
  }

  // ---------- the Cut tab (the Cut Editor in its frame; web/cutpanel.js passes messages both ways) ----------
  const cutPayload = () => ({ type: 'studio:shots', on: true, sel: selBrk,
    breaks: list().slice(1).map((s, k) => ({ id: s.id, n: k + 2, t: s.start, label: s.in ? trName(s.in) : '', section: Boolean(s.section) })) });
  function sendCut() { try { cutPost?.(cutPayload()); } catch {} }
  // The editor's messages: a "/" typed or pressed before a word (its start, take seconds), a "/" picked, deleted,
  // dragged to another word. at: where the "/" is on the page, for the popover.
  function fromCut(m, at) {
    if (m.type === 'studio:shot-add' && Number.isFinite(m.t)) return addAt(m.t);
    if (m.type === 'studio:shot-merge' && m.id) return merge(m.id);
    if (m.type === 'studio:shot-move' && m.id && Number.isFinite(m.t)) {
      const s = list().find((x) => x.id === m.id);
      if (s?.section) { toast(`This break is where ${sectionNote(s)}: it moves with the section's edge on the Sections band.`); sendCut(); return null; }
      return moveBreak(m.id, { t: m.t });
    }
    if (m.type === 'studio:shot-pick' && m.id) { pickBrk(m.id); if (at) openPop(m.id, at); return null; }
    if (m.type === 'studio:shot-desel') { if (selBrk) { selBrk = null; bump(); } closePop(); return null; }
    return null;
  }

  return {
    update, list, doc: () => doc, version: () => ver, label, lookOf, sectionAt, endOf: (i) => endOf(list(), i),
    bind(c) { C = c; },
    attach(t, { words: w, cut, picked: pk } = {}) {
      track = t; wordsOf = w || wordsOf; cutOf = cut || cutOf; picked = pk || picked; keySig = '';
      keys?.remove(); keyBtns = new Map(); acts?.remove(); actMap = new Map();
      keys = h('<div class="sh-keys" role="group" aria-label="Shots: Tab to a shot or a break"></div>');
      acts = h('<div class="prop-layer" role="group" aria-label="Claude’s proposed shots"></div>');
      track.root.querySelector('.tk-lanes')?.append(keys, acts);
    },
    detach() { keys?.remove(); keys = null; keyBtns = new Map(); acts?.remove(); acts = null; actMap = new Map(); ren?.remove(); ren = null; track = null; closePop(); },
    lane, words, overlay, syncKeys,
    sig: () => lane.sig(),
    selected: () => selBrk,
    deselect() { if (selBrk) { selBrk = null; bump(); sendCut(); } closePop(); },
    // Delete on the timeline: merge at the selected break (true when there was one).
    removeSel() { if (!selBrk) return false; merge(selBrk); return true; },
    escape() { if (pop) { closePop(); return true; } if (selBrk) { selBrk = null; bump(); sendCut(); return true; } return false; },
    split, slash, addAt, merge, moveBreak, setTransition, rename, renameBox, openPop, closePop, chain, op, actionToast, keep, reject,
    // the Cut tab
    setCutPost(fn) { cutPost = fn; sendCut(); }, sendCut, fromCut,
    // the inspector's "Into this shot"
    trName,
    applyAllLook: (sid) => op({ op: 'apply-all', id: sid }, { label: 'Apply to all shots' }),
    samePrev: (sid) => op({ op: 'same-as-previous', id: sid }, { label: 'Same as previous' }),
    backToVideo: (sid) => op({ op: 'clear', id: sid }, { label: "Back to the video's look" }),
    clearKeys: (ids, k) => op({ op: 'clear', ids, keys: k }, { label: 'Use the video’s look' }),
    // "Hide in all shots": the video's look hides it, and every shot that lists what it hides lists it too.
    async hideEverywhere(ref) {
      await C?.flush?.();
      const b = structuredClone(baseLook());
      if (!b) return null;
      b.hidden = [...new Set([...(b.hidden || []), ref])];
      const L = list().map((s) => {
        if (!s.look?.hidden) return s;
        const look = pruneToBase({ ...s.look, hidden: [...new Set([...s.look.hidden, ref])] }, b);
        const out = { ...s };
        if (look) out.look = look; else delete out.look;
        return out;
      });
      return chain([{ op: 'restore', doc: { ...(doc || {}), v: 1, shots: L }, layout: b }], { label: `Hide the ${ref === 'cam' ? 'camera' : 'screen'} in all shots`, fromCanvas: true });
    },
  };
}
