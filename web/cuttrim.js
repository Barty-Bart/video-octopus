// Trimming a cut from Scenes. It is the same cut as the
// Cut tab: Video Octopus reads the take the Cut Editor plays (GET /cut-take: its words and the cut now) and saves the whole cut
// back (POST /cut-save → work/edl_manual.json, kept in the change package as its one cut item), so the Cut tab, Scenes
// and the package always agree.
// One scene: grab a cut's red line (left half = the part before, right half = the part after) and pull ◀ ▶: it trims or
// brings back as you go and snaps to words (trim A). Settings → Editing B "highlight first": a trim shows red and only
// closes when you let go (bringing back shows blue at once). C "fine-trim pop-up": a click on a cut opens the trim lens.
// Whole video: a cut is a hairline there, so pressing one always opens the lens right above it.
// While a cut moves, the picture shows the take at the edge (the last frame before the cut, or the first one after it)
// with the other side of the join in a corner, and a short blip of sound plays from the edge, as in the Cut Editor.
import { h, esc, api, toast } from './ui.js';
import { alpha, tokens, c2 } from './tlcore.js';

const r3 = (x) => Math.round(x * 1000) / 1000;
export const sec = (d) => `${d > 0 ? '+' : d < 0 ? '−' : '±'}${Math.abs(d).toFixed(2)} s`;
const clone = (segs) => segs.map(([a, b]) => [a, b]);
const LENS_WIN = 3; // seconds the lens shows around each side of the cut

// ---------- cut maths ----------
// A cut ({segments} of the take, in order): take ⇄ cut time, and its joins (i: the part after, t: where it sits on the
// cut, e: where the part before ends in the take, s: where the part after starts).
export function segMap(segments) {
  const parts = [];
  let c = 0;
  for (const [a, b] of [...(segments || [])].sort((x, y) => x[0] - y[0])) { parts.push({ a, b, c }); c += b - a; }
  const len = c;
  return {
    parts, len,
    toSrc(t) { for (const p of parts) if (t < p.c + (p.b - p.a)) return p.a + Math.max(0, t - p.c); return parts.length ? parts[parts.length - 1].b : t; },
    // A moment that's cut out lands on the next kept one.
    toCut(x) { for (const p of parts) { if (x < p.a) return p.c; if (x < p.b) return p.c + x - p.a; } return len; },
    kept: (x) => parts.some((p) => x >= p.a - 1e-4 && x < p.b),
    next: (x) => parts.find((p) => p.a > x + 1e-4)?.a ?? null,
    joins: parts.slice(1).map((p, k) => ({ i: k + 1, t: p.c, e: parts[k].b, s: p.a })),
  };
}
// Old cut time → take → new cut time: the same as server/cutsync.mjs cutMapper, so what Scenes shows is what Save re-times to.
export function cutMapper(A, B) {
  const toTake = (t) => { let d = 0; for (const [a, b] of A) { const L = b - a; if (t <= d + L + 1e-6) return a + Math.max(0, t - d); d += L; } return A.length ? A[A.length - 1][1] : t; };
  const fromTake = (x) => { let d = 0; for (const [a, b] of B) { if (x < a - 1e-6) return d; if (x <= b + 1e-6) return d + (x - a); d += b - a; } return d; };
  const lenA = A.reduce((s, [a, b]) => s + b - a, 0), lenB = B.reduce((s, [a, b]) => s + b - a, 0);
  return (t) => (t > lenA ? lenB + (t - lenA) : fromTake(toTake(t)));
}
// What changed between two cuts, along the old one (server/scenes.mjs cutEdits): [{kind, take, dur, at}].
export function cutEdits(from, to) {
  const minus = (A, B) => { const out = []; for (const [a, b] of A) { let parts = [[a, b]]; for (const [c, d] of B) parts = parts.flatMap(([x, y]) => (d <= x || c >= y ? [[x, y]] : [[x, Math.min(y, c)], [Math.max(x, d), y]].filter(([p, q]) => q - p > 0.02))); out.push(...parts); } return out; };
  const onOld = (t) => from.reduce((s, [a, b]) => s + Math.max(0, Math.min(t, b) - a), 0);
  return [...minus(from, to).map((r) => ({ kind: 'removed', take: r })), ...minus(to, from).map((r) => ({ kind: 'restored', take: r }))]
    .map((e) => ({ ...e, dur: r3(e.take[1] - e.take[0]), at: r3(onOld(e.take[0])) })).sort((a, b) => a.at - b.at);
}
// Sorted, touching parts joined, slivers dropped (the Cut Editor's norm()).
export function normSegs(segs) {
  const out = [];
  for (const [a, b] of [...segs].sort((x, y) => x[0] - y[0])) {
    if (b - a < 0.02) continue;
    const last = out[out.length - 1];
    if (last && a <= last[1] + 0.005) last[1] = Math.max(last[1], b); else out.push([a, b]);
  }
  return out.map(([a, b]) => [r3(a), r3(b)]);
}

// ---------- the controller ----------
// o: project, history (makeUndo), snapshot() → the cut the sheet and renders are on, opts() → {hl, lens},
//    frame() → {take, take2, label, insetLabel} (the picture's take videos) | null, scrubbing(on), changed() (redraw),
//    saved(notesDoc) (after a save), openCut(t) (the Cut tab at t on the cut), lensSpot(kind, t) → {parent, bottom, x}
//    (where the lens sits: its parent, its bottom above the parent's bottom, the cut's x),
//    wholeCuts() → [{t (old cut), tNew (cut now)}] the cuts Whole video shows
export function makeCutTrim(o) {
  const enc = encodeURIComponent(o.project);
  let take = null, loading = null, peaks = null, trial = null, pull = null, lens = null, ver = 0;
  const memo = new Map();
  const ready = () => Boolean(take?.ok && take.segments?.length && o.snapshot()?.length);
  const segs = () => trial || take?.segments || [];
  const bump = () => { ver++; memo.clear(); };

  async function load(force) {
    if (loading) return loading;
    if (take && !force) return take;
    loading = (async () => {
      try {
        const t = await api(`/api/projects/${enc}/cut-take`);
        take = t; bump();
        if (t.ok && (!peaks || peaks.f !== t.video)) {
          api(`/api/projects/${enc}/peaks?f=${encodeURIComponent(t.video)}`).then((p) => { if (p?.data?.length) { peaks = { f: t.video, rate: p.rate, data: p.data }; bump(); o.changed(); } }).catch(() => {});
        }
      } catch { take = { ok: false }; }
      loading = null;
      o.changed();
      return take;
    })();
    return loading;
  }

  // ---- the view of one scene: the cut now, laid out so the scene starts where it does on the sheet's timeline ----
  // toView(old) / toOld(view) for times on the sheet's timeline; srcToView / viewToSrc for the take. The offset keeps
  // the scene's start in place, so only what comes after an edit moves (and an untouched scene doesn't move at all).
  function axis(s) {
    const A = o.snapshot(), B = segs();
    const key = `ax|${ver}|${s?.id}|${s?.start}|${A?.length}`;
    if (memo.has(key)) return memo.get(key);
    let ax;
    if (!ready() || !s) ax = { id: true, off: 0, toView: (t) => t, toOld: (t) => t, joins: [], len: 0, edits: [] };
    else {
      const m = cutMapper(A, B), N = segMap(B), O = segMap(A), off = s.start - m(s.start);
      ax = { off, m, N, toView: (t) => m(t) + off, toOld: (v) => O.toCut(N.toSrc(v - off)), srcToView: (x) => N.toCut(x) + off, viewToSrc: (v) => N.toSrc(v - off),
        joins: N.joins.map((j) => ({ ...j, t: j.t + off })), len: N.len, edits: cutEdits(A, B) };
    }
    memo.set(key, ax);
    return ax;
  }
  // A scene the cut change reaches: it gets longer or shorter, or an edit sits inside it.
  function touched(s) {
    if (!ready() || !s) return false;
    const ax = axis(s);
    if (ax.id) return false;
    const len = ax.toView(s.end) - ax.toView(s.start);
    return Math.abs(len - (s.end - s.start)) > 0.004 || ax.edits.some((e) => e.at > s.start + 1e-3 && e.at < s.end - 1e-3);
  }
  // The take's words on the view (a word cut in two keeps the kept part).
  function words(ax) {
    const key = `w|${ver}|${ax.off}`;
    if (memo.has(key)) return memo.get(key);
    const out = [], ws = take?.words || [];
    // Words and parts are both in order: find each part's first word, then walk (long takes stay quick while pulling).
    if (ax.N) for (const p of ax.N.parts) {
      let lo = 0, hi = ws.length;
      while (lo < hi) { const m = (lo + hi) >> 1; if (ws[m][0] < p.a - 1e-4) lo = m + 1; else hi = m; }
      for (let i = lo; i < ws.length && ws[i][0] < p.b; i++) { const [a, b, w] = ws[i]; out.push([p.c + ax.off + (a - p.a), p.c + ax.off + (Math.min(b, p.b) - p.a), w]); }
    }
    memo.set(key, out);
    return out;
  }
  // The take's waveform on the view, for [lo, hi] (the scene and a little around it).
  function wave(ax, lo, hi) {
    if (!peaks || !ax.N) return null;
    const key = `p|${ver}|${ax.off}|${Math.floor(lo)}|${Math.ceil(hi)}`;
    if (memo.has(key)) return memo.get(key);
    const R = peaks.rate, data = new Uint8Array(Math.max(1, Math.ceil(hi * R) + 2));
    for (const p of ax.N.parts) {
      const v0 = p.c + ax.off, v1 = v0 + (p.b - p.a);
      for (let k = Math.max(0, Math.ceil(Math.max(lo, v0) * R)); k < Math.min(data.length, Math.ceil(Math.min(hi, v1) * R)); k++) data[k] = peaks.data[Math.floor((p.a + k / R - v0) * R)] || 0;
    }
    const out = { rate: R, data };
    memo.set(key, out);
    return out;
  }

  // ---- the picture follows the edge ----
  let scrub = null, blipT = null;
  function scrubTo(t, side, other, dl) {
    const f = o.frame?.();
    if (!f) return;
    if (!scrub) { scrub = { last: 0, want: null }; f.take.pause(); o.scrubbing?.(true); }
    const fr = 1 / (take?.fps || 30), show = side === 'out' ? Math.max(0, t - fr) : t;
    scrub.want = show;
    f.label.textContent = `${side === 'out' ? 'Last frame before the cut' : 'First frame after the cut'}${Math.abs(dl) < 0.005 ? '' : ` · ${sec(dl)}`}`;
    if (other != null) {
      const ot = side === 'out' ? other : Math.max(0, other - fr);
      if (Math.abs(f.take2.currentTime - ot) > fr / 2) f.take2.currentTime = ot;
      f.insetLabel.textContent = side === 'out' ? 'After the cut' : 'Before the cut';
    }
    const now = performance.now();
    if (now - scrub.last > 120) {
      scrub.last = now; clearTimeout(blipT);
      f.take.muted = false; f.take.currentTime = side === 'out' ? Math.max(0, t - 0.16) : t;
      f.take.play().catch(() => {});
      blipT = setTimeout(() => { f.take.pause(); if (scrub) f.take.currentTime = scrub.want; }, 160);
    } else if (f.take.paused) f.take.currentTime = show;
  }
  function scrubEnd() {
    if (!scrub) return;
    clearTimeout(blipT);
    const f = o.frame?.(), want = scrub.want;
    scrub = null;
    if (f) { if (!f.take.paused) f.take.pause(); if (want != null) f.take.currentTime = want; }
    o.scrubbing?.(false);
  }

  // ---- saving: the whole cut, one undo step per pull or lens ----
  async function save(next) {
    if (!take?.ok) return false;
    let r;
    try { r = await api(`/api/projects/${enc}/cut-save`, { segments: next, version: take.version }); }
    catch (e) { toast(e.message); return false; }
    if (r.conflict) { toast('The cut changed in the Cut tab (or Claude changed it) after Scenes read it: Scenes has the new cut now, pull it again.'); await load(true); return false; }
    take.segments = clone(next); take.version = r.version; bump();
    await o.saved?.(r);
    return true;
  }
  async function commit(before, after, label) {
    trial = after; bump(); o.changed();
    const ok = JSON.stringify(before) === JSON.stringify(after) ? false : await save(after);
    trial = null; bump(); o.changed();
    if (!ok) return;
    o.history?.push({ label, undo: () => save(before), redo: () => save(after) });
    const d = segMap(after).len - segMap(before).len;
    toast(`${label}. The video is ${Math.abs(d).toFixed(2)} s ${d < 0 ? 'shorter' : 'longer'}; the cut waits in the change package.`);
  }
  // The word at a cut's edge (for the labels): the last one kept before it, or the first one after it.
  const wordAt = (x, side) => { const ws = take?.words || []; return side === 'out' ? [...ws].reverse().find((w) => w[0] < x - 0.02)?.[2] : ws.find((w) => w[1] > x + 0.02)?.[2]; };
  // Edges stick to the nearest word start or end within 8 px (⌘ places freely, like the timelines).
  function snapWord(x, within) {
    let best = x, bd = within;
    for (const w of take?.words || []) for (const y of [w[0], w[1]]) { const d = Math.abs(y - x); if (d < bd) { bd = d; best = y; } }
    return best;
  }

  // ---- A / B: pulling a cut's line on the scene timeline ----
  function startPull(j, side, x0) { const s = segs(); pull = { i: j.i, side, x0, t0: j.t, e0: s[j.i - 1][1], s0: s[j.i][0], before: clone(s), moved: false, pend: null, edge: null, delta: 0 }; }
  function movePull(p, v, e) {
    const d = pull;
    if (!d.moved && Math.abs(p.x - d.x0) <= 3) return;
    d.moved = true;
    const ds = v.tOf(p.x) - v.tOf(d.x0), px8 = Math.abs(v.tOf(8) - v.tOf(0)), hl = Boolean(o.opts().hl);
    const s = clone(d.before), i = d.i, snap = v.snapOn ? v.snapOn(e) : true;
    if (d.side === 'L') {
      const lo = s[i - 1][0] + 0.02, hi = s[i][0];
      let ne = Math.min(hi, Math.max(lo, d.e0 + ds));
      if (snap) ne = Math.min(hi, Math.max(lo, snapWord(ne, px8)));
      s[i - 1][1] = hl && ne < d.e0 ? d.e0 : ne;
      d.pend = ne < d.e0 - 1e-4 ? { a: ne, b: d.e0, kind: 'trim' } : ne > d.e0 + 1e-4 ? { a: d.e0, b: ne, kind: 'back' } : null;
      d.edge = ne; d.delta = ne - d.e0; d.word = wordAt(ne, 'out');
      scrubTo(ne, 'out', s[i][0], d.delta);
    } else {
      const lo = s[i - 1][1], hi = s[i][1] - 0.02;
      let ns = Math.max(lo, Math.min(hi, d.s0 + ds));
      if (snap) ns = Math.max(lo, Math.min(hi, snapWord(ns, px8)));
      s[i][0] = hl && ns > d.s0 ? d.s0 : ns;
      d.pend = ns > d.s0 + 1e-4 ? { a: d.s0, b: ns, kind: 'trim' } : ns < d.s0 - 1e-4 ? { a: ns, b: d.s0, kind: 'back' } : null;
      d.edge = ns; d.delta = d.s0 - ns; d.word = wordAt(ns, 'in');
      scrubTo(ns, 'in', s[i - 1][1], d.delta);
    }
    trial = s; bump(); o.changed();
  }
  async function endPull() {
    const d = pull;
    pull = null;
    if (!d.moved) {
      trial = null; bump(); scrubEnd(); o.changed();
      if (o.opts().lens) openLens(d.i, 'scene', d.t0);
      else o.openCut?.(segMap(d.before).joins.find((j) => j.i === d.i)?.t ?? 0);
      return;
    }
    const s = clone(trial || d.before);
    if (d.pend?.kind === 'trim') { if (d.side === 'L') s[d.i - 1][1] = d.pend.a; else s[d.i][0] = d.pend.b; }
    scrubEnd();
    const what = !d.pend ? 'Cut unchanged' : `${d.pend.kind === 'trim' ? 'Trimmed' : 'Brought back'} ${(d.pend.b - d.pend.a).toFixed(2)} s ${d.side === 'L' ? 'at the end of the part before' : 'at the start of the part after'} the cut at ${c2(d.t0)}`;
    if (!d.pend) { trial = null; bump(); o.changed(); return; }
    await commit(d.before, normSegs(s), what);
  }

  // The band the timelines put on their Words and Voice lanes: it catches a cut within 9 px (else it scrubs).
  // kind 'scene': the One scene timeline (its view from axis()); 'whole': Whole video (the sheet's timeline).
  function band(kind, axisOf) {
    const hit = (p, v) => {
      let best = null, bd = 9;
      if (kind === 'scene') for (const j of axisOf().joins) { const x = v.xOf(j.t), d = Math.abs(x - p.x); if (d <= bd) { bd = d; best = { i: j.i, t: j.t, x }; } }
      else {
        const N = segMap(segs());
        for (const c of o.wholeCuts?.() || []) {
          const x = v.xOf(c.t), d = Math.abs(x - p.x);
          if (d > bd) continue;
          const j = N.joins.reduce((a, b) => (Math.abs(b.t - c.tNew) < Math.abs((a?.t ?? 1e9) - c.tNew) ? b : a), null);
          if (j && Math.abs(j.t - c.tNew) < 0.6) { bd = d; best = { i: j.i, t: c.t, x }; }
        }
      }
      return best;
    };
    return {
      down(p, r, v) {
        if (lens) closeLens();
        const j = hit(p, v);
        if (!j) return false;
        if (kind === 'whole') { openLens(j.i, 'whole', j.t); return true; }
        startPull(j, p.x < j.x ? 'L' : 'R', p.x);
        return true;
      },
      move(p, r, v, e) { if (pull) movePull(p, v, e); },
      up() { if (pull) return endPull(); return undefined; },
      hover(p, r, v) {
        const j = hit(p, v);
        if (!j) return { cursor: 'text' };
        if (kind === 'whole') return { cursor: 'pointer', title: `Cut at ${c2(j.t)}\nPress to trim it here (the trim lens)` };
        const left = p.x < j.x;
        return { cursor: left ? 'w-resize' : 'e-resize', title: `Cut at ${c2(j.t)} · ${left ? 'the end of the part before' : 'the start of the part after'}\n${left ? '◀ trims · bring back ▶' : '◀ brings back · trim ▶'}${o.opts().hl ? ' (red trims when you let go)' : ''}\n${o.opts().lens ? 'Click: the trim lens' : 'Click: open it in the Cut tab'}` };
      },
    };
  }

  // ---- C: the trim lens (a close-up of one cut: the part before on top, the part after below) ----
  let lensEl = null, lensCv = null;
  // t: where the lens points on the timeline it opened from (One scene's view, or Whole video's sheet timeline).
  function openLens(i, kind, t) {
    if (lens) closeLens();
    const s = segs();
    if (!ready() || i < 1 || i >= s.length) return;
    lens = { i, kind, t, E0: s[i - 1][1], S0: s[i][0], before: clone(s), row: 1 };
    trial = clone(s); bump();
    const spot = o.lensSpot?.(kind, t);
    if (!spot) { lens = null; trial = null; return; }
    lensEl = h(`<div class="trim-lens" role="dialog" aria-label="Trim lens">
      <div class="trl-h"><b>Trim lens</b><span class="mono sub">${LENS_WIN} s around the cut · the faded parts are what the cut hides</span><span class="gap"></span>
        <span class="trl-d" aria-live="polite"></span><button class="btn ghost small" data-a="cut" title="Open this cut in the Cut tab">Cut tab</button><button class="btn dark small" data-a="done">Done ⏎</button></div>
      <div class="trl-b"><div class="trl-n" aria-hidden="true"><span>Part before</span><span>Part after</span></div><canvas class="trl-c" tabindex="0" aria-label="Click or drag in a row to move that side of the cut; arrow keys nudge the part before a frame, shift and arrow keys the part after"></canvas></div>
      <p class="trl-k sub">Click or drag in a row to move that side · ← → the part before · ⇧← ⇧→ the part after · Esc or ⏎ closes</p>
      <i class="trl-arrow" aria-hidden="true"></i></div>`);
    spot.parent.append(lensEl);
    place(spot);
    lensCv = lensEl.querySelector('canvas');
    lensEl.querySelector('[data-a=done]').onclick = () => closeLens();
    lensEl.querySelector('[data-a=cut]').onclick = () => { const t = segMap(segs()).joins.find((j) => j.i === lens.i)?.t ?? 0; closeLens(); o.openCut?.(t); };
    lensCv.addEventListener('pointerdown', lensDown);
    document.addEventListener('pointerdown', outside, true);
    document.addEventListener('keydown', lensKey, true);
    addEventListener('resize', drawLens);
    o.changed();
    requestAnimationFrame(() => { drawLens(); lensCv?.focus({ preventScroll: true }); });
    scrubTo(lens.E0, 'out', lens.S0, 0);
  }
  function place(spot) {
    if (!lensEl) return;
    lensEl.style.bottom = `${spot.bottom}px`;
    // The lens spans its parent with 14 px either side; its arrow (16 px) points at the cut.
    const w = spot.parent.clientWidth, x = Math.max(36, Math.min(w - 36, spot.x));
    lensEl.querySelector('.trl-arrow').style.left = `${x - 14 - 8}px`;
  }
  function closeLens(save = true) {
    if (!lens) return;
    const L = lens;
    lens = null;
    document.removeEventListener('pointerdown', outside, true);
    document.removeEventListener('keydown', lensKey, true);
    removeEventListener('resize', drawLens);
    lensEl?.remove(); lensEl = null; lensCv = null;
    scrubEnd();
    const after = normSegs(trial || L.before);
    if (!save || JSON.stringify(after) === JSON.stringify(normSegs(L.before))) { trial = null; bump(); o.changed(); return; }
    const s = trial;
    const dE = s[L.i - 1][1] - L.E0, dS = L.S0 - s[L.i][0];
    const what = ['Fine trim at the cut', Math.abs(dE) > 0.004 ? `part before ${sec(dE)}` : '', Math.abs(dS) > 0.004 ? `part after ${sec(dS)}` : ''].filter(Boolean).join(' · ');
    commit(L.before, after, what);
  }
  const outside = (e) => { if (lensEl && !lensEl.contains(e.target)) closeLens(); };
  function lensKey(e) {
    if (!lens || /TEXTAREA|INPUT/.test(document.activeElement?.tagName || '')) return;
    if (e.key === 'Escape' || e.key === 'Enter') { e.preventDefault(); e.stopImmediatePropagation(); closeLens(); return; }
    if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
      e.preventDefault(); e.stopImmediatePropagation();
      const d = (e.key === 'ArrowLeft' ? -1 : 1) / (take?.fps || 30), s = segs();
      if (e.shiftKey) lensSet(2, s[lens.i][0] + d); else lensSet(1, s[lens.i - 1][1] + d);
    }
  }
  function lensSet(row, x) {
    const s = clone(segs()), i = lens.i;
    lens.row = row;
    if (row === 1) { const E = Math.min(s[i][0] - 0.02, Math.max(s[i - 1][0] + 0.02, x)); s[i - 1][1] = E; trial = s; scrubTo(E, 'out', s[i][0], E - lens.E0); }
    else { const S = Math.max(s[i - 1][1] + 0.02, Math.min(s[i][1] - 0.02, x)); s[i][0] = S; trial = s; scrubTo(S, 'in', s[i - 1][1], lens.S0 - S); }
    bump(); drawLens(); o.changed();
  }
  function lensDown(e) {
    if (!lens) return;
    e.preventDefault();
    const r = lensCv.getBoundingClientRect(), row = e.clientY - r.top < r.height / 2 ? 1 : 2;
    try { lensCv.setPointerCapture(e.pointerId); } catch {}
    const at = (cx) => { const c = row === 1 ? lens.E0 : lens.S0, x = c - LENS_WIN / 2 + ((cx - r.left) / r.width) * LENS_WIN; return e.metaKey ? x : snapWord(x, (8 / r.width) * LENS_WIN); };
    lensSet(row, at(e.clientX));
    const mv = (ev) => lensSet(row, at(ev.clientX));
    const up = () => { lensCv?.removeEventListener('pointermove', mv); lensCv?.removeEventListener('pointerup', up); scrubEnd(); drawLens(); };
    lensCv.addEventListener('pointermove', mv); lensCv.addEventListener('pointerup', up);
  }
  function drawLens() {
    if (!lens || !lensCv || !take?.ok) return;
    const dpr = devicePixelRatio || 1, W = lensCv.clientWidth, H = lensCv.clientHeight;
    if (lensCv.width !== Math.round(W * dpr) || lensCv.height !== Math.round(H * dpr)) { lensCv.width = Math.round(W * dpr); lensCv.height = Math.round(H * dpr); }
    const g = lensCv.getContext('2d'), s = segs(), i = lens.i, E = s[i - 1][1], S = s[i][0], rh = (H - 6) / 2;
    g.setTransform(dpr, 0, 0, dpr, 0, 0); g.clearRect(0, 0, W, H); g.textBaseline = 'middle';
    const font = getComputedStyle(lensCv).fontFamily || 'system-ui';
    const tok = tokens(lensCv); // the look's colours (Settings → Appearance); fallbacks are Edit Bay's
    const bad = tok('--bad', '#dc2626'), C = { bg: tok('--wash', '#fbfbfa'), on: tok('--tl-wave', '#8e8d88'), off: tok('--tl-wave-off', '#deddd8'), word: tok('--panel-3', '#f0efec'),
      wordLine: tok('--row-line', '#e0dfda'), ink: tok('--text-2', '#33333a'), inkOff: tok('--ini', '#a1a09b'), dash: tok('--todo-ring', '#9a9994'), tip: tok('--text', '#1a1a1c'), tipInk: tok('--inverse', '#fff') };
    const row = (y, c, edge, before, orig) => {
      const xs = (x) => ((x - c + LENS_WIN / 2) / LENS_WIN) * W, solid = (x) => (before ? x < edge : x >= edge);
      g.fillStyle = C.bg; g.beginPath(); g.roundRect(0, y, W, rh, 8); g.fill();
      // the waveform: kept bars dark, what the cut hides light
      if (peaks) for (let x = 0; x < W; x += 3) {
        const t = c - LENS_WIN / 2 + (x / W) * LENS_WIN, i0 = Math.floor(t * peaks.rate);
        let m = 0; for (let q = i0; q < i0 + Math.max(1, Math.ceil((3 / W) * LENS_WIN * peaks.rate)); q++) m = Math.max(m, peaks.data[q] || 0);
        const hh = Math.max(1.5, Math.min(1, Math.sqrt(m / 100) * 1.25) * (rh - 34));
        g.fillStyle = solid(t) ? C.on : C.off; g.fillRect(x, y + 30 + (rh - 34) / 2 - hh / 2, 2, hh);
      }
      g.font = `500 11.5px ${font}`;
      for (const [a, b, w] of take.words) {
        if (b < c - LENS_WIN / 2 || a > c + LENS_WIN / 2) continue;
        const x0 = xs(a), x1 = xs(b), on = solid((a + b) / 2), ww = Math.max(4, x1 - x0 - 2);
        g.fillStyle = on ? C.word : 'rgba(255,255,255,0)'; g.beginPath(); g.roundRect(x0 + 1, y + 6, ww, 20, 4); g.fill();
        if (!on) { g.strokeStyle = C.wordLine; g.lineWidth = 1; g.stroke(); }
        g.save(); g.beginPath(); g.rect(x0 + 3, y + 6, Math.max(0, ww - 4), 20); g.clip();
        g.fillStyle = on ? C.ink : C.inkOff; g.font = `${on ? '' : 'italic '}500 11.5px ${font}`; g.textAlign = 'center'; g.fillText(w, x0 + 1 + ww / 2, y + 16.5); g.textAlign = 'left';
        g.restore();
      }
      if (Math.abs(orig - edge) > 0.004) { const xo = Math.round(xs(orig)) + 0.5; g.strokeStyle = C.dash; g.lineWidth = 1.5; g.setLineDash([4, 3]); g.beginPath(); g.moveTo(xo, y + 2); g.lineTo(xo, y + rh - 2); g.stroke(); g.setLineDash([]); }
      const xe = xs(edge);
      g.fillStyle = alpha(bad, 0.14); g.fillRect(xe - 7, y, 14, rh);
      g.fillStyle = bad; g.beginPath(); g.roundRect(xe - 2, y, 4, rh, 2); g.fill();
      return xe;
    };
    const x1 = row(0, lens.E0, E, true, lens.E0), x2 = row(rh + 6, lens.S0, S, false, lens.S0);
    const px = lens.row === 1 ? x1 : x2, py = lens.row === 1 ? rh - 14 : 2 * rh - 8;
    g.font = `500 11px ${font}`;
    const label = '◀ pull the line ▶', tw = g.measureText(label).width + 16, lx = Math.max(2, Math.min(W - tw - 2, px - tw / 2));
    g.fillStyle = C.tip; g.beginPath(); g.roundRect(lx, py - 9, tw, 18, 6); g.fill(); g.fillStyle = C.tipInk; g.fillText(label, lx + 8, py);
    const dE = E - lens.E0, dS = lens.S0 - S, tot = dE + dS;
    const d = lensEl.querySelector('.trl-d'), word = wordAt(E, 'out');
    d.textContent = Math.abs(tot) < 0.004 ? 'unchanged' : `${sec(tot)}${word ? ` · “${word}”` : ''}`;
    d.classList.toggle('back', tot > 0); d.classList.toggle('none', Math.abs(tot) < 0.004);
  }

  return {
    load, ready, axis, touched, words, wave, band,
    segs, take: () => take, fps: () => take?.fps || 30,
    // What the timelines draw while a cut moves: the pull (side, where it started, the pending trim or bring-back).
    pulling: () => (pull?.moved ? pull : null), lensAt: () => (lens ? { i: lens.i, kind: lens.kind, t: lens.t } : null),
    busy: () => Boolean(pull?.moved || lens), lensOpen: () => Boolean(lens), version: () => ver,
    replace: (spot) => place(spot),
    closeLens, stamp: () => take?.version,
    destroy: () => { closeLens(false); },
  };
}
