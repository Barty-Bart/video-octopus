// Scene timeline: one scene up close, on the shared timeline core
// (web/tlcore.js: zoom, scrubbing, snapping you can see, selection, J/K/L, I/O, undo). Each word is a box over its own
// slice of the voice waveform; every graphic the scene draws through the scene kit is a clip on its own row (an element
// drawn inside another sits under it, indented; one that shows more than once gets a clip each time), with ◇ where its
// motion changes (sampled from the scene: hover for the values, click to jump there) and ◆ for the creator's own
// keyframes (drag to retime, Delete removes, ⌘D copies to the playhead). Dragging a clip, its edges or the scene's edges
// asks for new timing: it becomes a change in the package (Claude re-times it); keyframes save at once (the kit plays them).
// The cut's joins are red lines through the words and the voice: pull one to trim the cut (web/cuttrim.js). While a cut
// change waits, the timeline shows the cut as it is now: graphics after it slide (dashed: where they were) and the
// scene's end moves.
import { esc, clock } from './ui.js';
import { makeTrack, diamond, wave, firstWord, c2 } from './tlcore.js';

// o: scene() → {id, n, start, end, title, was: {start, end}|null}; words() → [[a, b, w]]; peaks() → {rate, data} | null;
//    clips() → {state: 'loading'|'ready'|'nokit'|'oldkit'|'none'|'norender', list: [{id, label, in, out, on, moved, depth, text,
//               runs: [{in, out, ghost: {in, out}|null, waiting: {in, out}|null}], marks: [{t, x, y, w, h, o, what}], keys: [{t, t0, dx, dy, s, o, e}]}]};
//    beats() → [{t, label}] (shown while there are no clips); sfx() → [{t|null, label, waiting}]; notes() → [{id, t, n, tone, on, text}];
//    camera() → [{a, b, label, waiting}] the camera's place in the scene (from its layout); neighbours() → {prev, next} scene numbers;
//    edgeWaiting() → {start, end} | null; time(), playing(), seek(t), play(), pause(), media();
//    cuts() → [t] the cut's joins; cutsWaiting() → [{t, tNew, label}]; cutBand() → the pull band (web/cuttrim.js) | null;
//    trim() → {seam: {t, t0, delta, word, side}, pend: {a, b, kind}, end: {t, was, d}} while a cut moves or waits; sig() → redraw key;
//    pickClip(id), pickNote(id), hover(id|null), edge({kind: 'scene'|'clip', id, label, run, runs, from, to}), askKit(), updateKit(),
//    keys: {move([{el, t, to}]), remove([{el, t}]), duplicate([{el, t}])}, hideEl(id, on), project, undo, toast, keyGuard
export function makeSceneTimeline(host, o) {
  const sc = () => o.scene();
  const pad = () => { const s = sc(); return s ? Math.max(0.4, (s.end - s.start) * 0.06) : 0.4; };
  const edges = () => { const s = sc(), ew = o.edgeWaiting(); return { start: ew?.start ?? s.start, end: ew?.end ?? s.end, waiting: Boolean(ew) }; };
  const clipsNow = () => o.clips();
  const ready = () => clipsNow().state === 'ready';
  const pct = (x) => `${Math.max(0, Math.min(100, x * 100)).toFixed(3)}%`;

  const lanes = () => {
    const band = o.cutBand?.() || null, cut = band ? { band } : { extra: cutAt };
    const L = [
      { k: 'words', label: 'Words', h: 28, min: 20, max: 48, scrub: true, draw: (g, r, v) => { drawPend(g, r, v); drawWords(g, r, v); drawCuts(g, r, v); }, ...cut },
      { k: 'voice', label: 'Voice', h: 46, min: 24, max: 140, scrub: true, cls: 'voice', draw: (g, r, v) => { drawVoice(g, r, v); drawPend(g, r, v); drawCuts(g, r, v); }, ...cut },
    ];
    const cl = clipsNow();
    if (cl.state === 'ready') {
      for (const c of cl.list) L.push({ k: `el:${c.id}`, label: c.label, h: 24, min: 18, max: 48, flags: ['hide', 'lock'], cls: `${c.on ? 'on' : ''}${c.depth ? ` nest d${Math.min(3, c.depth)}` : ''}`, title: `${c.label} (${c.id})${c.parent ? ` · inside ${c.parentLabel || c.parent}` : ''}`,
        draw: (g, r, v) => drawClip(g, r, v, c), items: () => clipItems(c), extra: (p, r, v) => markAt(c, p, v) });
      if (!cl.list.length) L.push({ k: 'msg', label: 'Graphics', h: 26, draw: (g, r, v) => msg(g, r, v, 'No movable graphics in this scene.') });
    } else {
      L.push({ k: 'msg', label: 'Graphics', h: 26, draw: (g, r, v) => msg(g, r, v, cl.state === 'loading' ? 'Finding the scene’s graphics…' : '') });
      const beats = o.beats() || [];
      if (beats.length) L.push({ k: 'beats', label: 'Beats', h: 22, draw: (g, r, v) => drawBeats(g, r, v, beats) });
    }
    if (o.camera) L.push({ k: 'camera', label: 'Camera', h: 22, min: 18, max: 40, draw: drawCamera, title: 'Where the camera is in this scene (from its layout; change it in the Look tab)' });
    L.push({ k: 'sfx', label: 'Sound', h: 22, min: 18, max: 40, draw: drawSfx });
    L.push({ k: 'notes', label: 'Notes', h: 22, min: 18, max: 40, draw: drawNotes,
      items: () => (o.notes() || []).map((n) => ({ id: `note:${n.id}`, a: n.t, b: n.t, point: true, nid: n.id, label: `note ${n.n}`, seekOnClick: true, seekAt: n.t, tip: n.text ? `Note ${n.n}: ${n.text}` : `Note ${n.n}` })) });
    return L;
  };

  // The cut's joins: red hairlines through the words and the voice (the one being pulled thicker, with a glow).
  function drawCuts(g, r, v) {
    const pulled = o.trim?.()?.seam;
    for (const t of o.cuts?.() || []) {
      if (t < v.v0 || t > v.v1) continue;
      const x = Math.round(v.xOf(t)), on = pulled && Math.abs(pulled.t - t) < 1e-3;
      if (on) { g.fillStyle = v.col.a(v.col.bad, 0.16); g.fillRect(x - 7, r.y + 1, 14, r.h - 2); }
      g.fillStyle = v.col.a(v.col.bad, 0.85); g.fillRect(x - (on ? 2 : 1), r.y + 1, on ? 4 : 2, r.h - 2);
      if (r.k === 'words') { g.beginPath(); g.moveTo(x - 5, r.y + 1); g.lineTo(x + 5, r.y + 1); g.lineTo(x, r.y + 7); g.closePath(); g.fill(); } // a notch to aim for
    }
    // Cut changes not sent yet (when Scenes can't show the cut as it is now): dashed orange, where they sit on this (old) timeline.
    for (const w of o.cutsWaiting?.() || []) {
      if (w.t < v.v0 || w.t > v.v1) continue;
      const x = Math.round(v.xOf(w.t));
      g.fillStyle = v.col.a(v.col.accent, 0.9);
      for (let y = r.y + 1; y < r.y + r.h - 1; y += 6) g.fillRect(x - 1, y, 2, Math.min(3, r.y + r.h - 1 - y));
      if (r.k === 'words') { g.font = '600 10px system-ui, sans-serif'; g.fillText(w.label, x + 4, r.y + 10); }
    }
  }
  // B "highlight first": what a pull trims shows red until you let go, what it brings back blue.
  function drawPend(g, r, v) {
    const p = o.trim?.()?.pend;
    if (!p || p.b < v.v0 || p.a > v.v1) return;
    const x = v.xOf(p.a), x2 = v.xOf(p.b);
    g.fillStyle = p.kind === 'trim' ? 'rgba(248,81,73,0.26)' : 'rgba(80,150,255,0.24)';
    g.fillRect(x, r.y + 1, Math.max(1, x2 - x), r.h - 1);
  }
  function cutAt(p, r, v) {
    if (!o.openCut) return null;
    let t = null, best = 9, w = null; // the line is thin: catch clicks within 9 px of it, the nearest cut wins
    for (const x of o.cuts?.() || []) { const d = Math.abs(v.xOf(x) - p.x); if (d <= best) { best = d; t = x; } }
    for (const x of o.cutsWaiting?.() || []) { const d = Math.abs(v.xOf(x.t) - p.x); if (d <= best) { best = d; w = x; t = null; } }
    if (w) return { cursor: 'pointer', click: () => o.openCut(w.tNew), tip: `Cut change waiting for Claude: ${w.label} here\nSave changes → Claude sends it · click to see it in the Cut tab` };
    return t == null ? null : { cursor: 'pointer', click: () => o.openCut(t), tip: `Cut at ${c2(t)}\nClick to trim it in the Cut tab` };
  }

  // Over every lane: the pull's label and where the cut was, where the scene used to end, and the scenes either side.
  function overlay(g, v, top, H) {
    const { col } = v, tr = o.trim?.() || {}, s = sc();
    if (!s) return;
    g.font = `500 10.5px ${col.font}`; g.textBaseline = 'middle';
    const pill = (x, y, text, bg, fg = col.inverse, align = 'center') => {
      const w = g.measureText(text).width + 14, lx = align === 'right' ? x - w : align === 'left' ? x : x - w / 2, cx = Math.max(2, Math.min(v.W - w - 2, lx));
      g.fillStyle = bg; g.beginPath(); g.roundRect(cx, y - 9, w, 18, 6); g.fill(); g.fillStyle = fg; g.fillText(text, cx + 7, y + 0.5);
    };
    const dashed = (t) => { if (t < v.v0 || t > v.v1) return; const x = Math.round(v.xOf(t)) + 0.5; g.strokeStyle = col.dash; g.lineWidth = 1.5; g.setLineDash([4, 3]); g.beginPath(); g.moveTo(x, top); g.lineTo(x, H); g.stroke(); g.setLineDash([]); };
    if (tr.end) {
      dashed(tr.end.was);
      if (tr.end.t >= v.v0 && tr.end.t <= v.v1) pill(v.xOf(tr.end.t) - 8, H - 12, `scene ends ${Math.abs(tr.end.d).toFixed(2)} s ${tr.end.d < 0 ? 'sooner' : 'later'}`, col.text, col.inverse, 'right');
    }
    const sm = tr.seam;
    if (sm) {
      if (Math.abs(sm.t0 - sm.t) > 0.004) dashed(sm.t0);
      if (sm.t >= v.v0 && sm.t <= v.v1) pill(v.xOf(sm.t), top + 11, `${sm.delta < 0 ? '◀' : '▶'} ${sm.delta < 0 ? '−' : '+'}${Math.abs(sm.delta).toFixed(2)} s${sm.word ? ` · “${sm.word}”` : ''}`, col.bad, '#fff');
    }
    // The scenes either side, in the hatching.
    const nb = o.neighbours?.() || {}, xa = v.xOf(s.start), xb = v.xOf(s.end);
    g.font = `600 10px ${col.font}`; g.fillStyle = col.faint;
    if (nb.prev && xa > 22) { g.textAlign = 'left'; g.fillText(`‹ ${nb.prev}`, 5, H - 9); }
    if (nb.next && xb < v.W - 22) { g.textAlign = 'right'; g.fillText(`${nb.next} ›`, v.W - 5, H - 9); }
    g.textAlign = 'left';
  }

  // ---------- graphics: a clip per element (one each time it shows), its keys and the markers where its motion changes ----------
  const keyId = (c, k) => `key:${c.id}:${k.t0 ?? k.t}`;
  function clipItems(c) {
    const runs = c.runs?.length ? c.runs : [{ in: c.in, out: c.out, waiting: c.waiting }];
    const out = runs.map((run, k) => {
      const a = run.waiting?.in ?? run.in, b = run.waiting?.out ?? run.out;
      return { id: `clip:${c.id}:${k}`, a, b, label: runs.length > 1 ? `${c.label} (${k + 1} of ${runs.length})` : c.label, move: true, trim: true, host: true, el: c.id, clip: c, run: k, runs: runs.length, seekOnClick: true,
        tip: `${c.label}${runs.length > 1 ? ` (${k + 1} of ${runs.length})` : ''} · on screen ${c2(a)}–${c2(b)}${run.waiting ? ' · new timing waiting for Claude' : ''}${run.ghost ? ` · was ${c2(run.ghost.in)}–${c2(run.ghost.out)} before the cut change` : ''}\nDrag to move, drag an edge to retime (goes in the change package)` };
    });
    for (const k of c.keys || []) out.push({ id: keyId(c, k), a: k.t, b: k.t, point: true, move: true, label: `${c.label} keyframe`, el: c.id, key: k, seekOnClick: true, seekAt: k.t,
      tip: `◆ Keyframe ${c2(k.t)} · x ${fmtD(k.dx)} y ${fmtD(k.dy)} · size ${Math.round((k.s ?? 1) * 100)}% · opacity ${Math.round((k.o ?? 1) * 100)}%${k.e === 'linear' ? ' · linear' : ''}\nDrag to retime, Delete removes, ⌘D copies to the playhead` });
    return out;
  }
  const fmtD = (d) => `${(d || 0) > 0 ? '+' : (d || 0) < 0 ? '−' : ''}${Math.abs(Math.round(d || 0))}`;
  function markAt(c, p, v) {
    const m = (c.marks || []).find((x) => Math.abs(v.xOf(x.t) - p.x) <= 5);
    if (!m) return null;
    return { cursor: 'pointer', click: () => { o.seek(m.t); o.pickClip(c.id, true); },
      tip: `◇ ${c2(m.t)} · ${m.what}\nx ${Math.round(m.x)} y ${Math.round(m.y)} · ${Math.round(m.w)}×${Math.round(m.h)} · opacity ${Math.round(m.o * 100)}%\nClick to jump here` };
  }
  function drawClip(g, r, v, c) {
    const { col } = v, y = r.y + 3, hh = r.h - 6;
    const items = clipItems(c).filter((it) => !it.key);
    // Where it was before the cut change: a dashed outline.
    for (const run of c.runs || []) {
      if (!run.ghost || run.ghost.out < v.v0 || run.ghost.in > v.v1) continue;
      const gx = v.xOf(run.ghost.in), gx2 = Math.max(gx + 4, v.xOf(run.ghost.out));
      g.strokeStyle = col.dashLine; g.lineWidth = 1; g.setLineDash([3, 3]); g.beginPath(); g.roundRect(gx + 0.5, y + 0.5, gx2 - gx - 1, hh - 1, 4); g.stroke(); g.setLineDash([]);
    }
    let labelled = false;
    for (const it of items) {
      const p = v.pos(it), run = (c.runs || [])[it.run] || {};
      if (p.b < v.v0 || p.a > v.v1) continue;
      const on = c.on || v.isSel(it.id), hv = v.hoverId === it.id, slid = Boolean(run.ghost);
      const x = v.xOf(p.a), x2 = Math.max(x + 4, v.xOf(p.b));
      g.fillStyle = on ? col.selSoft : hv ? col.gfxHover : slid ? col.selSoft : c.depth ? col.gfxDeep : col.gfx;
      g.beginPath(); g.roundRect(x, y, x2 - x, hh, 4); g.fill();
      if (run.waiting) {
        g.save(); g.clip(); g.strokeStyle = col.a(col.accent, 0.18); g.lineWidth = 3;
        for (let k = x - hh; k < x2; k += 9) { g.beginPath(); g.moveTo(k, y + hh); g.lineTo(k + hh, y); g.stroke(); }
        g.restore();
        g.strokeStyle = col.accent; g.lineWidth = 1.5; g.beginPath(); g.roundRect(x, y, x2 - x, hh, 4); g.stroke();
      } else if (on) { g.strokeStyle = col.sel; g.lineWidth = 1.5; g.stroke(); }
      else if (slid) { g.strokeStyle = col.a(col.sel, 0.55); g.lineWidth = 1; g.stroke(); }
      // Cut short by the cut change: a red edge where it now stops (or starts).
      if (run.ghost && Math.abs((run.out - run.in) - (run.ghost.out - run.ghost.in)) > 0.004) {
        g.fillStyle = col.bad;
        if (Math.abs(run.in - run.ghost.in) < 0.004) g.fillRect(x2 - 2, y, 2, hh); else g.fillRect(x, y, 2, hh);
      }
      // Edge grips.
      if (x2 - x > 16) { g.fillStyle = on ? col.sel : 'rgba(0,0,0,0.08)'; g.fillRect(x, y, 4, hh); g.fillRect(x2 - 4, y, 4, hh); }
      if (x2 - x > 30 && (!labelled || items.length > 1)) {
        labelled = true;
        // The name starts after any ◇ / ◆ sitting at the clip's start.
        let lx = Math.max(x, 0) + 8;
        for (const t of [...(c.marks || []).map((m) => m.t), ...(c.keys || []).map((k) => k.t)].sort((p2, q2) => p2 - q2)) { const mx = v.xOf(t); if (mx >= lx - 8 && mx <= lx + 4) lx = mx + 9; }
        g.save(); g.beginPath(); g.rect(x + 6, r.y, x2 - x - 12, r.h); g.clip();
        g.fillStyle = on ? col.selText : col.gfxInk; g.font = `500 10px ${col.font}`;
        const extra = it.run === 0 ? `${c.moved ? ' · moved' : ''}${c.keys?.length ? ` · ${c.keys.length} key${c.keys.length > 1 ? 's' : ''}` : ''}` : '';
        const moved = slid ? (Math.abs(run.in - run.ghost.in) > 0.004 ? ` · slides ${Math.abs(run.in - run.ghost.in).toFixed(2)} s with its words` : ` · ${Math.abs((run.out - run.in) - (run.ghost.out - run.ghost.in)).toFixed(2)} s ${run.out - run.in < run.ghost.out - run.ghost.in ? 'shorter' : 'longer'}`) : '';
        g.fillText(`${it.runs > 1 ? `${c.label} · ${it.run + 1}` : c.label}${extra}${moved}`, lx, r.y + r.h / 2);
        g.restore();
      }
    }
    const cy = r.y + r.h / 2, on = c.on;
    // ◇ where Claude's own animation changes (start, settle, turn).
    for (const m of c.marks || []) {
      const mx = v.xOf(m.t);
      if (mx < -6 || mx > v.W + 6) continue;
      diamond(g, mx, cy, 4, col.panel, on ? col.sel : col.gfxMark, 1.3);
    }
    // ◆ the creator's keyframes, with a thin line between them.
    const ks = (c.keys || []).map((k) => ({ k, t: v.pos({ id: keyId(c, k), a: k.t, b: k.t }).a })).sort((a2, b2) => a2.t - b2.t);
    if (ks.length > 1) { g.fillStyle = col.accent; g.globalAlpha = 0.55; g.fillRect(v.xOf(ks[0].t), cy - 0.75, v.xOf(ks.at(-1).t) - v.xOf(ks[0].t), 1.5); g.globalAlpha = 1; }
    for (const { k, t } of ks) {
      const kx = v.xOf(t), s = v.isSel(keyId(c, k));
      diamond(g, kx, cy, s ? 6.5 : 5.5, s ? col.sel : col.accent, '#fff', 1.5);
    }
  }
  function msg(g, r, v, text) {
    if (!text) return;
    g.fillStyle = v.col.muted; g.font = `500 12px ${v.col.font}`; g.fillText(text, 10, r.y + r.h / 2);
  }
  function drawBeats(g, r, v, beats) {
    const { col } = v;
    for (const b of beats) {
      if (b.t < v.v0 - 3 || b.t > v.v1) continue;
      const x = v.xOf(b.t);
      g.fillStyle = col.gfxLine; g.fillRect(x, r.y + 3, 2, r.h - 6);
      g.save(); g.beginPath(); g.rect(x + 4, r.y, 170, r.h); g.clip(); g.fillStyle = col.text2; g.font = `500 10px ${col.font}`; g.fillText(b.label, x + 6, r.y + r.h / 2); g.restore();
    }
  }
  // The camera's place in the scene (full frame, a card, cut out, or none), from the scene's layout.
  function drawCamera(g, r, v) {
    const { col } = v;
    for (const c of o.camera() || []) {
      if (c.b < v.v0 || c.a > v.v1) continue;
      const x = Math.max(-2, v.xOf(c.a)) + 1, x2 = Math.min(v.W + 2, v.xOf(c.b)) - 1, y = r.y + 3, hh = r.h - 6;
      g.fillStyle = c.none ? 'rgba(0,0,0,0)' : col.quiet;
      g.beginPath(); g.roundRect(x, y, Math.max(2, x2 - x), hh, 4); g.fill();
      if (c.none) { g.strokeStyle = col.line2; g.setLineDash([3, 3]); g.lineWidth = 1; g.stroke(); g.setLineDash([]); }
      if (c.waiting) { g.strokeStyle = col.accent; g.lineWidth = 1.5; g.setLineDash([4, 3]); g.stroke(); g.setLineDash([]); }
      g.save(); g.beginPath(); g.rect(x + 4, r.y, Math.max(0, x2 - x - 8), r.h); g.clip();
      g.fillStyle = c.none ? col.faint : col.text2; g.font = `500 10.5px ${col.font}`; g.fillText(c.label, x + 7, r.y + r.h / 2);
      g.restore();
    }
  }

  // ---------- words over the waveform ----------
  function drawWords(g, r, v) {
    const { col } = v, ws = o.words(), t = v.time;
    for (let i = firstWord(ws, v.v0); i < ws.length; i++) {
      const [a, b, w] = ws[i];
      if (a > v.v1) break;
      if (b < v.v0) continue;
      const x = v.xOf(a), xw = Math.max(1, v.xOf(b) - x - 1), now = t >= a && t < b;
      g.fillStyle = now ? col.text : col.word;
      g.beginPath(); g.roundRect(x, r.y + 5, xw, r.h - 10, 3); g.fill();
      if (xw > 14) {
        g.save(); g.beginPath(); g.rect(x + 2, r.y, xw - 4, r.h); g.clip();
        g.fillStyle = now ? col.inverse : col.text; g.font = `500 10.5px ${col.font}`; g.textAlign = 'center'; g.fillText(w, x + xw / 2, r.y + r.h / 2); g.textAlign = 'left';
        g.restore();
      }
    }
  }
  function drawVoice(g, r, v) {
    g.fillStyle = v.col.voice; g.fillRect(0, r.y + 1, v.W, r.h - 1);
    wave(g, r, v, o.peaks(), v.col.wave, { gain: 1.3 });
    // Every word start carried down through the waveform.
    const ws = o.words();
    g.fillStyle = v.col.tick;
    for (let i = firstWord(ws, v.v0); i < ws.length && ws[i][0] <= v.v1; i++) g.fillRect(Math.round(v.xOf(ws[i][0])), r.y, 1, r.h);
  }
  function drawSfx(g, r, v) {
    const { col } = v, s = sc();
    for (const x of o.sfx() || []) {
      const t = x.t ?? Math.max(v.v0, s.start);
      if (t < v.v0 - 2 || t > v.v1) continue;
      const px = v.xOf(t), y = r.y + 4, hh = r.h - 8;
      g.fillStyle = col.cue; g.strokeStyle = col.accent; g.lineWidth = 1;
      if (x.t != null) { g.beginPath(); g.roundRect(px - 6, y, 12, hh, 3); g.fill(); g.stroke(); }
      else {
        g.font = `500 10px ${col.font}`; const w = g.measureText(x.label).width + 12;
        g.beginPath(); g.roundRect(px, y, w, hh, 4); g.fill(); g.fillStyle = col.cueText; g.fillText(x.label, px + 6, r.y + r.h / 2);
      }
      if (x.waiting) { g.setLineDash([3, 2]); g.strokeStyle = col.accent; g.strokeRect(px - 8, y - 2, 16, hh + 4); g.setLineDash([]); }
    }
  }
  function drawNotes(g, r, v) {
    const { col } = v;
    for (const n of o.notes() || []) {
      if (n.t < v.v0 - 0.5 || n.t > v.v1 + 0.5) continue;
      const x = v.xOf(n.t), y = r.y + r.h / 2, on = n.on || v.isSel(`note:${n.id}`);
      g.fillStyle = { open: col.accent, sent: col.warn, done: col.text, question: col.text, resolved: col.line }[n.tone] || col.accent;
      g.beginPath(); g.arc(x, y, on ? 8 : 7, 0, Math.PI * 2); g.fill();
      if (on) { g.strokeStyle = col.sel; g.lineWidth = 2; g.stroke(); }
      g.fillStyle = n.tone === 'done' || n.tone === 'question' ? col.inverse : n.tone === 'resolved' ? col.resolvedInk : col.accentInk; g.font = `600 9px ${col.font}`; g.textAlign = 'center'; g.fillText(String(n.n), x, y + 0.5); g.textAlign = 'left';
    }
  }

  // ---------- the track ----------
  const r2 = (x) => Math.round(x * 100) / 100;
  const track = makeTrack(host, {
    id: 'scene', project: o.project, title: 'Scene timeline', cls: 'stl', labelsW: 140, minSpan: 0.6, fitLabel: 'Whole scene',
    sub: `<div class="stl-mini tk-sub" title="Where this window sits in the scene: click to move it there"><span class="stl-mini-l mono"></span><div class="stl-mini-bar"><i class="win"></i><i class="ph"></i></div></div>
      <div class="stl-notice" hidden></div>`,
    bounds: () => { const s = sc(); return s ? [s.start - pad(), s.end + pad()] : [0, 1]; },
    home: () => { const s = sc(); return [s.start, s.end]; },
    viewKey: () => sc()?.id,
    time: () => o.time(), playing: () => o.playing(), seek: (t) => o.seek(t), play: () => o.play?.(), pause: () => o.pause?.(), media: () => o.media?.(),
    lanes, overlay,
    snaps: () => {
      const [v0, v1] = track.view(), ws = o.words(), out = [];
      for (let i = firstWord(ws, v0); i < ws.length && ws[i][0] <= v1; i++) out.push({ t: ws[i][0], word: ws[i][2], label: 'a word' });
      if (ready()) for (const c of clipsNow().list) for (const m of c.marks || []) out.push({ t: m.t, label: `◇ ${c.label} (${m.what})` });
      for (const b of o.beats() || []) out.push({ t: b.t, label: `beat “${b.label}”` });
      return out;
    },
    guides: () => { const s = sc(); if (!s) return []; const e = edges(); return [{ id: 'scene-start', t: e.start, drag: true, waiting: e.waiting, title: `Scene starts ${c2(e.start)}: drag to move it` }, { id: 'scene-end', t: e.end, drag: true, waiting: e.waiting, title: `Scene ends ${c2(e.end)}: drag to move it` }]; },
    shade: () => { const s = sc(); if (!s) return []; const e = edges(), [lo, hi] = [s.start - pad(), s.end + pad()]; return [[lo, e.start], [e.end, hi]]; },
    sig: () => {
      const cl = clipsNow();
      return [sc()?.id, sc()?.end, cl.state, ready() ? cl.list.map((c) => `${c.id}:${c.in}:${c.out}:${c.on ? 1 : 0}:${c.moved ? 1 : 0}:${JSON.stringify(c.runs)}:${(c.keys || []).map((k) => `${k.t},${k.dx},${k.dy},${k.s},${k.o},${k.e || ''}`).join(';')}:${(c.marks || []).length}`).join('|') : '',
        JSON.stringify(o.edgeWaiting()), (o.notes() || []).map((n) => n.id + n.tone + n.t + (n.on ? 1 : 0)).join(), (o.sfx() || []).length, o.words().length, o.peaks()?.data.length, (o.cuts?.() || []).join(), o.sig?.()].join('#');
    },
    pick(it, e) {
      if (it.nid) return o.pickNote(it.nid);
      if (it.el) o.pickClip(it.el, true);
    },
    selected(items) { const k = items.find((x) => x.key); if (k) o.pickClip(k.el, true); },
    hover(it) { o.hover?.(it?.el || null); },
    commit(op) {
      if (op.kind === 'guide') {
        const s = sc(), e = edges(), to = { start: e.start, end: e.end };
        if (op.guide.id === 'scene-start') to.start = Math.min(op.t, to.end - 0.3); else to.end = Math.max(op.t, to.start + 0.3);
        return o.edge({ kind: 'scene', from: { start: r2(s.start), end: r2(s.end) }, to: { start: r2(to.start), end: r2(to.end) } });
      }
      if (op.kind === 'trim' && op.item.clip) {
        const c = op.item.clip, a = op.item.a, b = op.item.b, run = (c.runs || [])[op.item.run] || c;
        const to = op.edge === 'a' ? { in: op.t, out: b } : { in: a, out: op.t };
        return o.edge({ kind: 'clip', id: c.id, label: c.label, run: op.item.run, runs: op.item.runs, from: { in: r2(run.in), out: r2(run.out) }, to: { in: r2(to.in), out: r2(to.out) } });
      }
      if (op.kind === 'move') {
        const keys = op.items.filter((x) => x.key);
        if (keys.length) o.keys?.move(keys.map((x) => ({ el: x.el, t: x.key.t0 ?? x.key.t, to: Math.round((x.key.t + op.dt) * 1000) / 1000 })));
        for (const x of op.items.filter((y) => y.clip)) {
          const c = x.clip, run = (c.runs || [])[x.run] || c;
          o.edge({ kind: 'clip', id: c.id, label: c.label, run: x.run, runs: x.runs, from: { in: r2(run.in), out: r2(run.out) }, to: { in: r2(x.a + op.dt), out: r2(x.b + op.dt) } });
        }
      }
    },
    remove(items) {
      const keys = items.filter((x) => x.key);
      if (keys.length) { o.keys?.remove(keys.map((x) => ({ el: x.el, t: x.key.t0 ?? x.key.t }))); return true; }
      if (items.some((x) => x.clip)) { o.toast?.('Graphics are removed by Claude: add a note on it (or select its keyframes to delete them).'); return true; }
      return false;
    },
    duplicate(items) {
      const keys = items.filter((x) => x.key);
      if (keys.length) return o.keys?.duplicate(keys.map((x) => ({ el: x.el, t: x.key.t0 ?? x.key.t })));
      o.toast?.('Select a keyframe (◆) to copy it to the playhead.');
    },
    split: () => o.toast?.('S splits blocks on the Canvas timeline. Here, add a keyframe or drag a clip’s edges.'),
    focusRange: () => { const c = ready() && clipsNow().list.find((x) => x.on); if (c) return [c.in, c.out]; const s = sc(); return s ? [s.start, s.end] : null; },
    flags: (k, f) => { if (k.startsWith('el:')) o.hideEl?.(k.slice(3), f.hide); },
    undo: o.undo, toast: o.toast, keyGuard: o.keyGuard,
    help: [['Pull a red line', 'Trim the cut there (left half: the part before, right half: the part after)'], ['Click a ◇', 'Jump to where the graphic’s motion changes'], ['◆ drag · Delete · ⌘D', 'Retime · remove · copy a keyframe to the playhead'], ['↑ ↓', 'Previous · next scene'], ['N · A · E · C', 'Note · approve · edit graphics · compare with the previous render']],
  });
  const root = track.root, mini = root.querySelector('.stl-mini'), notice = root.querySelector('.stl-notice');
  mini.querySelector('.stl-mini-bar').addEventListener('pointerdown', (e) => {
    const b = e.currentTarget.getBoundingClientRect(), s = sc(), lo = s.start - pad(), L = s.end + pad() - lo;
    const t = lo + ((e.clientX - b.left) / b.width) * L, [v0, v1] = track.view();
    track.show(t - (v1 - v0) / 2, t + (v1 - v0) / 2, true);
  });

  // The message above the lanes when the graphics aren't on the timeline (yet).
  function paintNotice() {
    const cl = clipsNow(), st = cl.old && cl.state === 'ready' ? 'oldkit' : cl.state;
    const html = st === 'nokit' ? 'This scene’s graphics aren’t on the timeline yet. <button class="btn small" data-a="kit">Ask Claude to make them movable</button>'
      : st === 'oldkit' ? 'This project has an older copy of the Video Octopus scene kit: markers and keyframes need the new one (it only adds them; nothing else changes). <button class="btn small" data-a="kitup">Update the scene kit</button>'
        : st === 'norender' ? 'The graphics show here once the scene has a render.' : st === 'loading' ? '<span class="spin"></span>Finding the scene’s graphics and where they move…' : '';
    if (notice.dataset.st === st) return;
    notice.dataset.st = st;
    notice.hidden = !html;
    notice.innerHTML = html;
    notice.querySelector('[data-a=kit]')?.addEventListener('click', () => o.askKit());
    notice.querySelector('[data-a=kitup]')?.addEventListener('click', () => o.updateKit?.());
  }

  function tick() {
    const s = sc();
    if (!s) return;
    track.draw();
    const [v0, v1] = track.view(), lo = s.start - pad(), L = s.end + pad() - lo, t = o.time();
    const win = mini.querySelector('.win'), ph = mini.querySelector('.ph');
    win.style.left = pct((v0 - lo) / L); win.style.width = pct((v1 - v0) / L);
    ph.style.left = pct((t - lo) / L);
    const lab = `Scene ${clock(s.start)} – ${clock(s.end)}`, ml = mini.querySelector('.stl-mini-l');
    if (ml.textContent !== lab) ml.textContent = lab;
  }
  function render() { paintNotice(); track.redraw(); tick(); }

  return { render, tick, reset: () => track.refit(), metrics: () => track.metrics(), track, destroy: () => track.destroy() };
}
