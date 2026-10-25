import { $ } from './ui.js';
import { makeTrack, wave, firstWord, c2 } from './tlcore.js';

// ---------- timeline under the picture: blocks, sections, scenes, notes, words, voice, sound, the locked cut, clips ----------
// Lanes on the shared timeline core (web/tlcore.js: zoom, scrubbing, snapping, selection, keys, undo). Each lane draws
// itself and lists what can be picked or dragged on it; what an edit means is up to the page (o.*).
// o: duration(), time(), playing(), seek(t), play(), pause(), media() (J/K/L), project, undo, toast,
//   cut() → {segments}, clips() → [{label, file, ref, duration}], selected() → ref, select(ref), hover(ref|null), hideLayer(file, on)
//   scenes() → [{id, n, start, end, title, on, tone}], pickScene(id), openScene(id); notes() → [{id, t, n, tone, on}], pickNote(id), openNote(id)
//   sections() → [{id, label, start, end, on}]; sfx() → [{id, t, dur, label, on}], pickSfx(id), cues {move([{id, t}]), remove(ids), duplicate(ids)}, muteSfx(on)
//   band: the blocks lane (web/blocks.js), which draws and drags itself; sig() → redraw key; focus() → [a, b] for "zoom to selection"
//   zooms() → [{a, b, c, d, amount, why}] Add zooms' plan in take seconds (in from a to b, out from c to d), shown as is;
//   zoomsUI: the canvas's zooms (web/zoomsui.js makeZooms): the Zooms lane you edit instead (drag, trim, ease, select,
//   Delete, Keep it · No thanks on Claude's proposals); zoomKey() starts Z (a box on the picture);
//   graphics() → [{id, sid, n, start, end, label, text, on}] the scene graphics' spans; joins() → [{k, t, status 'clipped'|'check', word}], openJoin(j)
//   cuts() → [t] the cut's joins, cutsWaiting() → [{t, tNew, label}], openCut(t); cutBand() → a band that handles pressing a cut
//   (Scenes' trim lens, web/cuttrim.js) | null; cutActive() → t of the cut the lens is open on; scenes' trim: true outlines one
//   shots: the canvas's shots (web/shotsui.js makeShots): the Shots lane under the section band, "/" on the Words lane,
//   S splits a shot (⇧S and ⌘B the section), the shot being edited tinted across the lanes; the lanes then go in
//   's order (Sections, Shots, Zooms, Words, Voice, Scenes, Sound, Notes, Cut). Without it, as before.
export function makeTimeline(host, o) {
  let data = { words: [], peaks: null };
  const cut = () => o.cut?.() || null;
  function removed() {
    const c = cut();
    if (!c) return [];
    const segs = [...c.segments].sort((a, b) => a[0] - b[0]), out = [];
    let t = 0;
    for (const [a, b] of segs) { if (a > t) out.push([t, a]); t = Math.max(t, b); }
    const d = o.duration() || t;
    if (d > t) out.push([t, d]);
    return out;
  }
  const gone = (t) => removed().some(([s, e]) => t >= s && t < e);
  // fresh / building / queued: a running Build's progress per scene (B5b).
  const toneCol = (col, tone) => ({ ok: col.ok, fresh: col.ok, building: col.accent, changed: col.accent, notes: col.sel, sent: col.warn }[tone] || col.faint);

  // The Words lane with shots: "/" marks on top of the words (click, drag to another word, Delete), the cut's joins
  // still open the Cut tab; anywhere else scrubs.
  let wordsPress = null;
  const wordsBand = o.shots ? {
    down(p, r, v, e) {
      if (o.shots.words.down(p, r, v, e)) { wordsPress = 'slash'; return true; }
      const c = cutAt(p, r, v);
      if (c) { wordsPress = c; return true; }
      return false;
    },
    move(p, r, v, e) { if (wordsPress === 'slash') o.shots.words.move(p, r, v, e); },
    async up(e) { const w = wordsPress; wordsPress = null; if (w === 'slash') await o.shots.words.up(e); else w?.click?.(); },
    hover(p, r, v) {
      const hv = o.shots.words.hover(p, r, v);
      if (hv) return hv;
      const c = cutAt(p, r, v);
      return c ? { cursor: c.cursor, title: c.tip } : { cursor: 'text', title: '' };
    },
  } : null;
  const lanes = () => {
    const L = [];
    if (o.band?.on()) L.push({ k: 'band', label: o.shots ? 'Sections' : o.band.label || 'Blocks', h: o.band.height || 34, min: 28, max: 60, flags: ['lock'], band: o.band, draw: (g, r, v) => o.band.draw(g, r, v),
      title: o.shots ? 'Sections (the story): drag a boundary or a flag; click to select (⇧S splits, Delete joins or removes, ⌘D duplicates)' : 'Blocks: drag a boundary or a flag; click to select (S splits, Delete joins or removes, ⌘D duplicates)' });
    if (o.shots) L.push({ k: 'shots', label: 'Shots', note: 'you edit here', cls: 'strong', h: 36, min: 30, max: 60, band: o.shots.lane, draw: (g, r, v) => o.shots.lane.draw(g, r, v),
      title: 'Shots: the look over time. Click a shot to edit it on the canvas, S splits at the playhead, “/” in Words starts one at a word; drag a line to move it, select it and press Delete to merge. Double-click a shot to rename it.' });
    if (o.sections?.()?.length > 1) L.push({ k: 'sections', label: 'Sections', h: 24, draw: drawSections, items: () => o.sections().map((s) => ({ id: `section:${s.id}`, a: s.start, b: s.end, label: s.label, host: true, seekOnClick: true, select: false, snap: false })) });
    if (o.scenes?.()?.length) {
      L.push({ k: 'scenes', label: 'Scenes', h: 30, draw: drawScenes, items: () => o.scenes().map((s) => ({ id: `scene:${s.id}`, a: s.start, b: s.end, label: `Scene ${s.n}`, host: true, seekOnClick: true, sid: s.id, select: false, tip: `${s.n} · ${s.title}` })) });
      L.push({ k: 'notes', label: 'Notes', h: 22, draw: drawNotes, items: () => (o.notes?.() || []).map((n) => ({ id: `note:${n.id}`, a: n.t, b: n.t, point: true, label: `note ${n.n}`, nid: n.id, seekOnClick: true, seekAt: n.t, tip: n.text ? `Note ${n.n}: ${n.text}` : `Note ${n.n}` })) });
    }
    if (o.joins?.()?.length) L.push({ k: 'joins', label: 'Joins', h: 18, min: 14, max: 30, scrub: true, draw: drawJoins, extra: joinAt, title: 'The join check: red = likely clipped a word, amber = check it by ear. Click a flag to fix it in the Cut tab.' });
    const cb = o.cutBand?.() || null, cutHit = cb ? { band: cb } : wordsBand ? { band: wordsBand } : { extra: cutAt };
    L.push({ k: 'words', label: 'Words', h: 28, min: 20, max: 48, scrub: true, draw: (g, r, v) => { drawWords(g, r, v); drawCuts(g, r, v); if (o.shots) o.shots.words.draw(g, r, v); }, ...cutHit,
      ...(o.shots ? { title: 'Words: type “/” to start a new shot before the word at the playhead; click a “/” for its transition, drag it to another word, Delete merges' } : {}) });
    L.push({ k: 'voice', label: 'Voice', h: 40, min: 24, max: 120, scrub: true, draw: (g, r, v) => { wave(g, r, v, data.peaks, v.col.wave, { dim: gone }); drawCuts(g, r, v); }, ...cutHit });
    if (o.sfx?.()?.length) L.push({ k: 'sfx', label: 'Sound', h: 24, min: 20, max: 48, flags: ['mute', 'lock'], draw: drawSfx,
      items: () => o.sfx().map((c) => ({ id: `cue:${c.id}`, a: c.t, b: c.t + c.dur, minW: 8, label: c.label, move: true, cid: c.id, tip: `${c.label} · ${clockOf(c.t)} · drag to move, Delete removes, ⌘D duplicates` })) });
    if (o.zoomsUI) {
      const zl = o.zoomsUI.lane;
      L.push({ k: 'zooms', label: 'Zooms', h: 26, min: 20, max: 44, draw: (g, r, v) => zl.draw(g, r, v), title: 'Zooms: blue = the screen, orange = your face. Z, then drag a box on the picture, adds one at the playhead. Drag a zoom to move it, an end to trim it, a slope to ease faster or slower; Delete removes it. Dashed = Claude’s proposal: Keep it or No thanks.',
        band: { ...zl, down(p, r, v, e) { const took = zl.down(p, r, v, e); if (o.zoomsUI.selected()) { lastSel = 'zooms'; if (track.selection().length) track.select([]); o.band?.select?.(null); bandSel = null; o.shots?.deselect(); } return took; } } });
    } else if (o.zooms?.()?.length) L.push({ k: 'zooms', label: 'Zooms', h: 22, min: 16, max: 40, draw: drawZooms, title: 'Add zooms: where the camera punches in on your face and goes back out (work/zooms.json)',
      items: () => o.zooms().map((z, i) => ({ id: `zoom:${i}`, a: z.a, b: z.d, label: `Zoom ${i + 1}`, host: true, seekOnClick: true, select: false, snap: false, tip: `Zoom ${i + 1}${z.amount ? ` · ${z.amount}×` : ''} · in ${clockOf(z.a)}, out ${clockOf(z.d)}${z.why ? `\n${z.why}` : ''}` })) });
    if (cut()) L.push({ k: 'cut', label: 'Cut', h: 16, min: 12, max: 30, scrub: true, draw: drawCut });
    if (o.graphics?.()?.length) L.push({ k: 'graphics', label: 'Graphics', h: 26, min: 18, max: 44, draw: drawGraphics, title: 'What each scene shows, from the production sheet. Double-click one to open its scene.',
      items: () => o.graphics().map((x) => ({ id: `gfx:${x.id}`, a: x.start, b: x.end, label: x.label, host: true, seekOnClick: true, sid: x.sid, select: false, snap: false, tip: `Scene ${x.n} · ${x.text}\nDouble-click to open the scene` })) });
    if (o.shots) {
      const order = ['band', 'sections', 'shots', 'zooms', 'joins', 'words', 'voice', 'scenes', 'graphics', 'sfx', 'notes', 'cut'];
      L.sort((a, b) => order.indexOf(a.k) - order.indexOf(b.k));
    }
    for (const c of o.clips?.() || []) {
      const ref = c.ref;
      L.push({ k: `clip:${c.file}`, label: c.label, h: 26, min: 20, max: 48, flags: ['hide'], draw: (g, r, v) => drawClip(g, r, v, c),
        items: () => [{ id: `clip:${c.file}`, a: 0, b: c.duration || o.duration() || 0, label: c.label, host: true, seekOnClick: true, ref, select: false, snap: false, tip: `${c.label}: ${c.file}` }] });
    }
    return L;
  };
  const clockOf = (t) => { const m = Math.floor(t / 60); return `${m}:${(t % 60).toFixed(1).padStart(4, '0')}`; };

  // ---------- lanes ----------
  // Zooms: a ramp up while it punches in, the hold, a ramp down as it goes back out.
  function drawZooms(g, r, v) {
    const { col } = v;
    for (const z of o.zooms()) {
      if (z.d < v.v0 || z.a > v.v1) continue;
      const xa = v.xOf(z.a), xb = v.xOf(z.b), xc = v.xOf(z.c), xd = v.xOf(z.d), top = r.y + 4, bot = r.y + r.h - 3;
      g.beginPath(); g.moveTo(xa, bot); g.lineTo(xb, top); g.lineTo(xc, top); g.lineTo(xd, bot); g.closePath();
      g.fillStyle = col.accentSoft; g.fill(); g.strokeStyle = col.accent; g.lineWidth = 1.25; g.stroke();
      if (z.amount && xc - xb > 34) { g.fillStyle = col.text; g.font = `600 10px ${col.font}`; g.textBaseline = 'middle'; g.fillText(`${z.amount}×`, xb + 5, (top + bot) / 2 + 1); }
    }
  }
  function drawSections(g, r, v) {
    const { col } = v;
    for (const sc of o.sections()) {
      if (sc.end < v.v0 || sc.start > v.v1) continue;
      const x = Math.max(-2, v.xOf(sc.start)) + 1, x2 = Math.min(v.W + 2, v.xOf(sc.end)) - 1;
      g.fillStyle = sc.on ? col.gone : col.scene;
      g.beginPath(); g.roundRect(x, r.y + 3, Math.max(2, x2 - x), r.h - 6, 5); g.fill();
      if (x2 - x > 30) { g.save(); g.beginPath(); g.rect(x + 4, r.y, x2 - x - 8, r.h); g.clip(); g.fillStyle = col.text; g.font = `600 11px ${col.font}`; g.fillText(sc.label, x + 8, r.y + r.h / 2); g.restore(); }
    }
  }
  function drawScenes(g, r, v) {
    const { col } = v;
    for (const sc of o.scenes()) {
      if (sc.end < v.v0 || sc.start > v.v1) continue;
      const x = Math.max(-2, v.xOf(sc.start)) + 1, x2 = Math.min(v.W + 2, v.xOf(sc.end)) - 1, hv = v.hoverId === `scene:${sc.id}`;
      g.fillStyle = sc.trim ? col.trim : sc.on ? col.accentSoft : hv ? col.gone : col.scene;
      g.beginPath(); g.roundRect(x, r.y + 4, Math.max(2, x2 - x), r.h - 8, 5); g.fill();
      if (sc.on || sc.trim) { g.strokeStyle = col.accent; g.lineWidth = sc.trim ? 2 : 1.5; g.stroke(); }
      if (sc.tone) { g.fillStyle = toneCol(col, sc.tone); g.fillRect(x + 3, r.y + r.h - 7, Math.max(2, x2 - x - 6), 2); }
      if (x2 - x > 22) {
        g.save(); g.beginPath(); g.rect(x + 4, r.y, x2 - x - 8, r.h); g.clip();
        g.fillStyle = sc.on ? col.accent : col.clipText; g.font = `600 11px ${col.font}`; g.fillText(String(sc.n), x + 7, r.y + r.h / 2 - 1);
        g.font = `500 11px ${col.font}`; g.fillStyle = sc.on ? col.text : col.clipText; g.fillText(sc.title, x + 9 + g.measureText(String(sc.n)).width + 4, r.y + r.h / 2 - 1);
        g.restore();
      }
    }
  }
  function drawNotes(g, r, v) {
    const { col } = v;
    for (const n of o.notes?.() || []) {
      if (n.t < v.v0 - 0.5 || n.t > v.v1 + 0.5) continue;
      const x = v.xOf(n.t), y = r.y + r.h / 2, on = n.on || v.isSel(`note:${n.id}`);
      g.fillStyle = { open: col.accent, sent: col.warn, done: col.text, question: col.text, resolved: col.line }[n.tone] || col.accent;
      g.beginPath(); g.arc(x, y, on ? 8 : 7, 0, Math.PI * 2); g.fill();
      if (on) { g.strokeStyle = col.sel; g.lineWidth = 2; g.stroke(); }
      g.fillStyle = n.tone === 'resolved' ? col.muted : n.tone === 'done' || n.tone === 'question' ? col.inverse : col.accentInk; g.font = `600 9px ${col.font}`; g.textAlign = 'center';
      g.fillText(String(n.n), x, y + 0.5); g.textAlign = 'left';
    }
  }
  // The cut's joins (when the page passes them): red hairlines through the words and the voice; click one to open it.
  function drawCuts(g, r, v) {
    const act = o.cutActive?.();
    for (const t of o.cuts?.() || []) {
      if (t < v.v0 || t > v.v1) continue;
      const x = Math.round(v.xOf(t)), on = act != null && Math.abs(act - t) < 1e-3;
      if (on) { g.fillStyle = v.col.a(v.col.bad, 0.16); g.fillRect(x - 7, r.y + 1, 14, r.h - 2); g.fillStyle = v.col.bad; g.fillRect(x - 2, r.y + 1, 4, r.h - 2); continue; }
      g.fillStyle = v.col.a(v.col.bad, 0.85); g.fillRect(x - 1, r.y + 1, 2, r.h - 2);
      if (r.k === 'words') { g.beginPath(); g.moveTo(x - 5, r.y + 1); g.lineTo(x + 5, r.y + 1); g.lineTo(x, r.y + 7); g.closePath(); g.fill(); } // a notch to aim for
    }
    // Cut changes not sent yet: dashed orange, where they sit on this (old) timeline.
    for (const w of o.cutsWaiting?.() || []) {
      if (w.t < v.v0 || w.t > v.v1) continue;
      const x = Math.round(v.xOf(w.t));
      g.fillStyle = v.col.a(v.col.accent, 0.9);
      for (let y = r.y + 1; y < r.y + r.h - 1; y += 6) g.fillRect(x - 1, y, 2, Math.min(3, r.y + r.h - 1 - y));
      if (r.k === 'words') { g.font = '600 10px system-ui, sans-serif'; g.fillText(w.label, x + 4, r.y + 10); }
    }
  }
  // The join check's flags: a small flag at each join it marked, red (likely clipped) or amber (check), on a hairline.
  const joinCol = (j, col) => col.a(j.status === 'clipped' ? col.bad : col.warn, 1);
  function drawJoins(g, r, v) {
    for (const j of o.joins()) {
      if (j.t < v.v0 - 1 || j.t > v.v1 + 1) continue;
      const x = Math.round(v.xOf(j.t));
      g.fillStyle = joinCol(j, v.col);
      g.fillRect(x - 0.5, r.y + 2, 1, r.h - 3);
      g.beginPath(); g.moveTo(x - 5, r.y + 3); g.lineTo(x + 5, r.y + 3); g.lineTo(x, r.y + 11); g.closePath(); g.fill();
    }
  }
  function joinAt(p, r, v) {
    let best = null, d = 8;
    for (const j of o.joins()) { const dx = Math.abs(v.xOf(j.t) - p.x); if (dx <= d) { d = dx; best = j; } }
    if (!best) return null;
    const what = best.status === 'clipped' ? 'likely clipped a word' : 'check it by ear';
    return { cursor: 'pointer', click: () => o.openJoin?.(best), tip: `Join ${best.k + 1} at ${c2(best.t)}: ${what}${best.word ? ` (“${best.word}”)` : ''}\nClick to fix it in the Cut tab` };
  }
  // The scene graphics: one span per scene, named by what it shows.
  function drawGraphics(g, r, v) {
    const { col } = v;
    for (const x of o.graphics()) {
      if (x.end < v.v0 || x.start > v.v1) continue;
      const xa = Math.max(-2, v.xOf(x.start)) + 1, xb = Math.min(v.W + 2, v.xOf(x.end)) - 1, hv = v.hoverId === `gfx:${x.id}`;
      g.fillStyle = x.on ? col.gfxOn : hv ? col.gfxHover : col.gfx;
      g.beginPath(); g.roundRect(xa, r.y + 4, Math.max(2, xb - xa), r.h - 8, 5); g.fill();
      if (x.on) { g.strokeStyle = col.gfxEdge; g.lineWidth = 1.5; g.stroke(); }
      if (xb - xa > 26) { g.save(); g.beginPath(); g.rect(xa + 4, r.y, xb - xa - 8, r.h); g.clip(); g.fillStyle = col.gfxInk; g.font = `500 11px ${col.font}`; g.fillText(x.label, xa + 7, r.y + r.h / 2); g.restore(); }
    }
  }
  function cutAt(p, r, v) {
    if (!o.openCut) return null;
    let t = null, best = 9, w = null; // the line is thin: catch clicks within 9 px of it, the nearest cut wins
    for (const x of o.cuts?.() || []) { const d = Math.abs(v.xOf(x) - p.x); if (d <= best) { best = d; t = x; } }
    for (const x of o.cutsWaiting?.() || []) { const d = Math.abs(v.xOf(x.t) - p.x); if (d <= best) { best = d; w = x; t = null; } }
    if (w) return { cursor: 'pointer', click: () => o.openCut(w.tNew), tip: `Cut change waiting for Claude: ${w.label} here\nSave changes → Claude sends it · click to see it in the Cut tab` };
    return t == null ? null : { cursor: 'pointer', click: () => o.openCut(t), tip: `Cut at ${c2(t)}\nClick to trim it in the Cut tab` };
  }
  function drawWords(g, r, v) {
    const { col } = v, ws = data.words, t = v.time;
    const rm = removed().filter(([a, b]) => b > v.v0 && a < v.v1);
    for (let i = firstWord(ws, v.v0); i < ws.length; i++) {
      const [a, b, w] = ws[i];
      if (a > v.v1) break;
      if (b < v.v0) continue;
      const x = v.xOf(a), xw = Math.max(1, v.xOf(b) - x - 1);
      const out = rm.some(([s, e]) => a >= s && b <= e), now = t >= a && t < b;
      g.globalAlpha = out ? 0.4 : 1;
      g.fillStyle = now ? col.text : col.word;
      g.beginPath(); g.roundRect(x, r.y + 4, xw, r.h - 8, Math.min(4, xw / 2)); g.fill();
      if (xw > 18) { g.save(); g.beginPath(); g.rect(x + 3, r.y, xw - 5, r.h); g.clip(); g.fillStyle = now ? col.inverse : out ? col.muted : col.text; g.fillText(w, x + 4, r.y + r.h / 2); g.restore(); }
      g.globalAlpha = 1;
    }
  }
  function drawSfx(g, r, v) {
    const { col } = v;
    for (const c of o.sfx()) {
      const p = v.pos({ id: `cue:${c.id}`, a: c.t, b: c.t + c.dur });
      if (p.b < v.v0 || p.a > v.v1) continue;
      const on = c.on || v.isSel(`cue:${c.id}`), hv = v.hoverId === `cue:${c.id}`;
      const x = v.xOf(p.a), x2 = Math.max(x + 8, v.xOf(p.b));
      g.fillStyle = on ? col.selSoft : hv ? col.gone : col.cueLane;
      g.beginPath(); g.roundRect(x, r.y + 4, x2 - x, r.h - 8, 4); g.fill();
      if (on) { g.strokeStyle = col.sel; g.lineWidth = 1.5; g.stroke(); }
      g.fillStyle = on ? col.sel : col.cueMark; g.fillRect(x, r.y + 3, 2, r.h - 6);
      if (x2 - x > 34) { g.save(); g.beginPath(); g.rect(x + 5, r.y, x2 - x - 8, r.h); g.clip(); g.fillStyle = on ? col.text : col.cueInk; g.font = `500 10px ${col.font}`; g.fillText(c.label, x + 6, r.y + r.h / 2); g.restore(); }
    }
  }
  function drawCut(g, r, v) {
    const { col } = v, c = cut();
    for (const [a, b] of removed()) {
      if (b < v.v0 || a > v.v1) continue;
      const x = Math.max(0, v.xOf(a)), x2 = Math.min(v.W, v.xOf(b));
      g.fillStyle = col.gone; g.beginPath(); g.roundRect(x, r.y + 3, Math.max(1, x2 - x), r.h - 6, 3); g.fill();
    }
    g.fillStyle = col.keep;
    for (const [a, b] of c.segments) {
      if (b < v.v0 || a > v.v1) continue;
      const x = Math.max(0, v.xOf(a)), x2 = Math.min(v.W, v.xOf(b));
      g.beginPath(); g.roundRect(x, r.y + 5, Math.max(1, x2 - x), r.h - 10, 3); g.fill();
    }
  }
  function drawClip(g, r, v, c) {
    const { col } = v, on = c.ref && c.ref === o.selected?.(), hv = v.hoverId === `clip:${c.file}`;
    const x = v.xOf(0), x2 = v.xOf(c.duration || o.duration() || 0);
    if (x2 < 0 || x > v.W) return;
    g.fillStyle = on ? col.selSoft : hv ? col.gone : col.clip;
    g.beginPath(); g.roundRect(Math.max(-4, x), r.y + 3, Math.min(v.W + 8, x2) - Math.max(-4, x), r.h - 6, 5); g.fill();
    if (on) { g.strokeStyle = col.sel; g.lineWidth = 1.5; g.stroke(); }
    g.fillStyle = on ? col.sel : col.clipText;
    g.fillText(c.file, Math.max(0, x) + 8, r.y + r.h / 2);
  }

  const cueIds = (items) => items.filter((x) => x.cid).map((x) => x.cid);
  const keysHead = o.shots ? `<span class="tk-keys" role="group" aria-label="Shots"><button class="tk-key" data-k="slash" title="New shot before the word at the playhead (type “/”)"><kbd>/</kbd><span>in Words: new shot</span></button>
    <button class="tk-key" data-k="split" title="Split the shot at the playhead (S; ⇧S splits the section)"><kbd>S</kbd><span>split at the playhead</span></button>${o.zoomKey ? `
    <button class="tk-key" data-k="zoom" title="Zoom into an area: press Z, then drag a box on the screen or the camera"><kbd>Z</kbd><span>zoom into an area</span></button>` : ''}</span>` : '';
  const track = makeTrack(host, {
    id: o.trackId || 'main', project: o.project, title: 'Timeline', labelsW: 104, minSpan: 1, head: keysHead,
    bounds: () => [0, Math.max(0.5, o.duration() || 0)],
    viewKey: () => (o.duration() > 0 ? 'ready' : 'waiting'), // fit once the video's length is known
    time: () => o.time(), playing: () => o.playing(), seek: (t) => o.seek(t),
    play: () => o.play?.(), pause: () => o.pause?.(), media: () => o.media?.(),
    clock: () => o.clock?.() || null, // the cut's clock while the canvas plays the cut (tlcore clockMap)
    lanes,
    snaps: () => {
      const [v0, v1] = track.view(), out = [];
      for (let i = firstWord(data.words, v0); i < data.words.length && data.words[i][0] <= v1; i++) out.push({ t: data.words[i][0], word: data.words[i][2], label: 'a word' });
      for (const s of o.band?.on() ? o.band.snaps?.() || [] : []) out.push(s);
      return out;
    },
    veil: removed,
    sig: () => [o.sig?.(), o.shots?.sig(), o.zoomsUI?.sig(), (o.graphics?.() || []).length, (o.sfx?.() || []).map((c) => `${c.id}@${c.t}:${c.dur}${c.on ? '*' : ''}`).join(), o.band?.sig?.(), o.selected?.(), data.words.length, data.peaks?.data.length, cut()?.segments.length].join('|'),
    pick(it) {
      if (it.sid) o.pickScene?.(it.sid);
      else if (it.nid) o.pickNote?.(it.nid);
      else if (it.cid) o.pickSfx?.(it.cid);
      else if (it.ref !== undefined && it.ref) o.select?.(it.ref);
    },
    open(it) { if (it.nid) o.openNote?.(it.nid); else if (it.sid) o.openScene?.(it.sid); },
    selected(items) {
      if (items.length) { o.band?.select?.(null); bandSel = null; lastSel = 'core'; o.shots?.deselect(); o.zoomsUI?.deselect(); }
      const c = items.find((x) => x.cid);
      if (c) o.pickSfx?.(c.cid);
    },
    hover(it) { o.hover?.(it?.ref || null); },
    commit(op) {
      if (op.kind === 'move') { const list = op.items.filter((x) => x.cid).map((x) => ({ id: x.cid, t: Math.max(0, Math.round((x.a + op.dt) * 100) / 100) })); if (list.length) o.cues?.move(list); }
    },
    remove(items) {
      const ids = cueIds(items);
      if (o.shots?.selected() && lastSel === 'shots') return o.shots.removeSel();
      if (o.zoomsUI?.selected() && lastSel === 'zooms') return o.zoomsUI.removeSel();
      if (blockFirst()) { o.band.removeSel(); return true; }
      if (ids.length) { o.cues?.remove(ids); return true; }
      if (items.some((x) => x.nid)) { o.toast?.('Notes are removed in the Scenes tab.'); return true; }
      return false;
    },
    duplicate(items) {
      const ids = cueIds(items);
      if (blockFirst()) return o.band.duplicateSel();
      if (ids.length) return Promise.resolve(o.cues?.duplicate(ids)).then((made) => { if (made?.length) { track.select(made.map((x) => `cue:${x}`)); o.pickSfx?.(made[0]); } });
      if (o.band?.selected?.()) return o.band.duplicateSel();
      o.toast?.('Select a sound cue or a block to duplicate.');
    },
    split(t) {
      if (!o.band?.on()) return o.toast?.(o.shots ? 'There are no sections to split yet: S splits the shot.' : 'Splitting works on the blocks lane of the Canvas timeline.');
      Promise.resolve(o.band.split(t)).then((r) => { if (r?.id) { track.select([]); bandSel = r.id; lastSel = 'band'; } });
    },
    ...(o.shots ? { splitShot: (t) => o.shots.split(t), slash: (t) => o.shots.slash(t), escape: () => o.shots.escape(), overlay: (g, v, top, H) => o.shots.overlay(g, v, top, H) } : {}),
    focusRange: () => {
      const b = o.band?.selRange?.();
      if (b) return b;
      const s = o.scenes?.()?.find((x) => x.on);
      return s ? [s.start, s.end] : o.focus?.() || null;
    },
    flags(k, f) {
      if (k === 'sfx') o.muteSfx?.(f.mute);
      if (k.startsWith('clip:')) o.hideLayer?.(k.slice(5), f.hide);
    },
    undo: o.undo, toast: o.toast, keyGuard: o.keyGuard,
    help: o.help,
  });

  o.muteSfx?.(track.flags('sfx').mute); // a lane muted last time stays muted
  if (o.shots) {
    // A break picked (Shots lane, "/", keyboard, the Cut tab) is the selection Delete acts on, until something else is.
    o.shots.attach(track, { words: () => data.words, cut: () => cut()?.segments || null,
      picked: () => { lastSel = 'shots'; if (track.selection().length) track.select([]); o.band?.select?.(null); bandSel = null; o.zoomsUI?.deselect(); } });
    track.root.querySelector('.tk-key[data-k=slash]').onclick = () => o.shots.slash(o.time());
    track.root.querySelector('.tk-key[data-k=split]').onclick = () => o.shots.split(o.time());
    const zk = track.root.querySelector('.tk-key[data-k=zoom]');
    if (zk) zk.onclick = () => o.zoomKey();
  }
  o.zoomsUI?.attach(track);

  function setData(d) {
    data = { words: d.words || [], peaks: d.peaks || null };
    $('.tl-note', host).textContent = d.note || (data.words.length ? `${data.words.length} words` : 'No word times yet: run Transcribe');
    track.redraw();
  }

  // One selection at a time: picking a block (band, strip, a split) drops the timeline's own selection, and the other way
  // round; Delete and ⌘D act on whichever was picked last.
  let bandSel = null, lastSel = null;
  function syncBand() {
    const b = o.band?.on() ? o.band.selected?.() || null : null;
    if (b !== bandSel) { bandSel = b; if (b) { lastSel = 'band'; if (track.selection().length) track.select([]); } }
  }
  const blockFirst = () => { syncBand(); return Boolean(o.band?.selected?.()) && (lastSel === 'band' || !track.selection().some((x) => x.cid)); };
  function draw() {
    syncBand();
    if (o.shots?.selected() && lastSel !== 'shots' && bandSel) o.shots.deselect(); // a block picked after the break
    track.draw();
    o.shots?.syncKeys();
    o.zoomsUI?.syncKeys();
  }

  return {
    draw, setData,
    show: (a, b) => track.show(a, b, true),
    refit: () => track.refit(), metrics: () => track.metrics(), track,
    destroy: () => { o.shots?.detach(); o.zoomsUI?.detach(); track.destroy(); },
  };
}
