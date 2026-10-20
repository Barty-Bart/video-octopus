// Zooms in the editor: the Zooms lane on the canvas timeline and every zoom edit
// through POST /api/projects/<id>/zooms (server/shots.mjs; the ops are web/shots.js zoomsEdit), with undo from their
// before / after. Each zoom is a ramp: in, hold, out. Blue is the screen, orange with a face mark the camera. Drag the
// body to move it, an end to trim it, a slope to change how fast it eases in or out (0.1–2 s). Claude's proposals are
// dashed with Keep it · No thanks on each (the preview and the export leave them out until they're kept). The zoom
// inspector and Z + drag a box on the picture are the canvas's (web/app.js); it binds itself with bind().
//
// makeZooms({ id, getP, history }) → the controller. The canvas binds { time(), seek(t), picked(id | null) (a zoom was
// selected: show it in the inspector), changed() (the doc changed: redraw) }.
import { h, api, toast } from './ui.js';
import { tokens, lookKey } from './tlcore.js';
import { ZOOM_TARGETS } from './layout.js';
import { RAMP_MIN, RAMP_MAX, MIN_ZOOM, clock } from './shots.js';

const same = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
const SCREEN_BLUE = '#2f7de1';

// Keep it · No thanks next to each proposal on a lane: small real buttons laid over the canvas (they take focus and
// have names; the canvas lane under them still gets every other click). want: [{ key, x, x2, y, h, name }] in the
// lanes' own pixels; act(key, 'keep' | 'reject').
export function syncPropActs(host, store, want, act) {
  const seen = new Set();
  for (const w of want) {
    seen.add(w.key);
    let g = store.get(w.key);
    if (!g) {
      g = h(`<span class="prop-acts" role="group"><button type="button" class="pa-keep" data-a="keep">Keep it</button><button type="button" class="pa-no" data-a="reject">No thanks</button></span>`);
      g.addEventListener('pointerdown', (e) => e.stopPropagation());
      g.querySelectorAll('button').forEach((b) => (b.onclick = (e) => { e.stopPropagation(); act(g.__key, b.dataset.a); }));
      store.set(w.key, g);
      host.append(g);
    }
    g.__key = w.key;
    g.setAttribute('aria-label', `Claude's proposal: ${w.name}`);
    g.querySelector('.pa-keep').title = `Keep it: ${w.name}`;
    g.querySelector('.pa-no').title = `No thanks: ${w.name}`;
    const room = w.x2 - w.x, short = room < 150;
    g.classList.toggle('short', short);
    g.hidden = room < 64; // a short proposal: pick it, and its tag on the picture has the buttons
    const gw = short ? 46 : 132;
    g.style.cssText = `left:${Math.round(Math.max(w.x + 2, w.x2 - gw - 4))}px;top:${Math.round(w.y + (w.h - 20) / 2)}px`;
  }
  for (const [k, g] of store) if (!seen.has(k)) { g.remove(); store.delete(k); }
}

export function makeZooms({ id, getP, history }) {
  const url = `/api/projects/${encodeURIComponent(id)}/zooms`;
  let doc = null, C = null, track = null, sel = null, ver = 0, opAt = 0, inFlight = 0, drag = null;
  let acts = null, actMap = new Map(), actSig = '';
  const list = () => doc?.items || [];
  const bump = () => { ver++; };
  const label = (z, n = list().indexOf(z)) => `Zoom ${n + 1}${z?.name ? ` · ${z.name}` : ''}`;

  function update() {
    const d = getP().zooms;
    if (!d || !Array.isArray(d.items) || inFlight || Date.now() - opAt < 1200 || same(d, doc)) return;
    doc = d; bump();
    if (sel && !list().some((z) => z.id === sel)) { sel = null; C?.picked?.(null); }
    C?.changed?.();
  }
  async function restore(d) {
    const r = await api(url, { op: 'restore', doc: d });
    doc = r.zooms; opAt = Date.now(); bump();
    if (sel && !list().some((z) => z.id === sel)) { sel = null; C?.picked?.(null); }
    C?.changed?.();
  }
  // chain(bodies, { label, quiet }) → the last result, or null (with a toast) when an op is refused. One undo step.
  async function chain(bodies, { label: what = 'Zooms', quiet = false } = {}) {
    inFlight++;
    let first = null, last = null;
    try { for (const b of bodies) { const r = await api(url, b); first ||= r; last = r; } }
    catch (e) { toast(e.message); }
    finally { inFlight--; }
    if (!last) return null;
    doc = last.zooms; opAt = Date.now(); bump();
    if (sel && !list().some((z) => z.id === sel)) { sel = null; C?.picked?.(null); }
    const before = first.before, after = last.after;
    history?.push({ label: what, undo: () => restore(before), redo: () => restore(after) });
    C?.changed?.();
    if (!quiet && last.note) toast(last.note);
    return last;
  }
  const op = (b, o) => chain([b], o);
  function select(zid, { seek = false } = {}) {
    sel = zid || null; bump();
    const z = list().find((x) => x.id === sel);
    if (z && seek) { const t = C?.time?.() ?? 0; if (t < z.a || t > z.d) C?.seek?.(z.a + Math.min(0.2, (z.d - z.a) / 2)); }
    C?.picked?.(sel);
  }
  const keep = (ids) => op({ op: 'keep', ...(ids === 'all' ? { all: true } : { ids }) }, { label: 'Keep a zoom' });
  const reject = (ids) => op({ op: 'reject', ...(ids === 'all' ? { all: true } : { ids }) }, { label: 'Turn down a zoom' });

  // ---------- colours ----------
  let pal = null, palKey = '';
  function colors() {
    const k = lookKey();
    if (pal && palKey === k) return pal;
    const g = tokens();
    pal = { panel: g('--panel', '#ffffff'), panel2: g('--panel-2', '#fafaf8'), line2: g('--line-2', '#dcdbd6'), text: g('--text', '#1a1a1c'), muted: g('--muted', '#55555a'),
      sel: g('--sel', '#2563eb'), accent: g('--accent', '#c2410c'), font: g('--font', 'system-ui') };
    palKey = k;
    return pal;
  }
  const tone = (z) => (z.target === 'screen' ? SCREEN_BLUE : colors().accent);

  // ---------- the lane ----------
  // The zoom as drawn (a drag in progress moves the one being dragged).
  const shape = (z) => (drag?.moved && drag.id === z.id ? drag.z : z);
  function drawLane(g, r, v) {
    const c = colors(), top = r.y + 4, bot = r.y + r.h - 3;
    g.save();
    g.textBaseline = 'middle';
    for (const z0 of list()) {
      const z = shape(z0);
      if (z.d < v.v0 || z.a > v.v1) continue;
      const xa = v.xOf(z.a), xb = v.xOf(z.b), xc = v.xOf(z.c), xd = v.xOf(z.d), on = z0.id === sel, prop = z0.status === 'proposed', col = tone(z0);
      g.beginPath(); g.moveTo(xa, bot); g.lineTo(xb, top); g.lineTo(xc, top); g.lineTo(xd, bot); g.closePath();
      g.fillStyle = v.col.a(col, prop ? 0.08 : on ? 0.3 : 0.18); g.fill();
      g.strokeStyle = on ? c.sel : col; g.lineWidth = on ? 2 : 1.25;
      if (prop) g.setLineDash([4, 3]);
      g.stroke(); g.setLineDash([]);
      if (on) for (const x of [xa, xd]) { g.fillStyle = c.sel; g.fillRect(Math.round(x) - 1.5, top, 3, bot - top); }
      // a face mark on camera zooms, then the name or the amount
      let tx = xb + 5;
      if (z0.target !== 'screen' && xc - xb > 18) { g.strokeStyle = col; g.lineWidth = 1.2; g.beginPath(); g.arc(tx + 4, (top + bot) / 2 - 1, 3, 0, Math.PI * 2); g.stroke(); g.beginPath(); g.arc(tx + 4, (top + bot) / 2 + 7, 5, Math.PI * 1.15, Math.PI * 1.85); g.stroke(); tx += 12; }
      const text = z0.name || (z0.box ? 'Area' : z0.amount ? `${z0.amount}×` : '');
      const room = xc - tx - (prop ? 52 : 4);
      if (text && room > 24) {
        g.font = `${on ? 600 : 500} 10.5px ${c.font}`; g.fillStyle = c.text;
        let s = text; while (s.length > 1 && g.measureText(s).width > room) s = s.slice(0, -1);
        g.fillText(s === text ? s : `${s.slice(0, -1)}…`, tx, (top + bot) / 2 + 1);
      }
    }
    g.restore();
  }
  // What's under the pointer: the topmost zoom (the later one), and which part: an end, a slope or the body.
  function hit(p, v) {
    const L = list();
    for (let k = L.length - 1; k >= 0; k--) {
      const z = L[k], xa = v.xOf(z.a), xb = v.xOf(z.b), xc = v.xOf(z.c), xd = v.xOf(z.d);
      if (p.x < xa - 5 || p.x > xd + 5) continue;
      const part = Math.abs(p.x - xa) <= 5 ? 'a' : Math.abs(p.x - xd) <= 5 ? 'd' : p.x < xb && xb - xa > 12 ? 'in' : p.x > xc && xd - xc > 12 ? 'out' : 'body';
      return { z, part };
    }
    return null;
  }
  const CURSOR = { a: 'ew-resize', d: 'ew-resize', in: 'col-resize', out: 'col-resize', body: 'grab' };
  const TIP = { a: 'drag to trim the start', d: 'drag to trim the end', in: 'drag to ease in faster or slower', out: 'drag to ease out faster or slower', body: 'drag to move it' };
  const lane = {
    label: 'Zooms', height: 26,
    sig: () => `${ver}|${sel}|${drag ? `${drag.moved}:${drag.z?.a}:${drag.z?.b}:${drag.z?.c}:${drag.z?.d}` : ''}|${palKey}`,
    draw: (g, r, v) => drawLane(g, r, v),
    down(p, r, v) {
      const ht = hit(p, v);
      if (!ht) { if (sel) select(null); return false; }
      select(ht.z.id);
      drag = { id: ht.z.id, part: ht.part, x0: p.x, t0: v.tOf(p.x), z: { ...ht.z }, orig: { ...ht.z }, moved: false };
      return true;
    },
    move(p, r, v, e) {
      if (!drag) return;
      if (Math.abs(p.x - drag.x0) > 3) drag.moved = true;
      if (!drag.moved) return;
      const o = drag.orig, z = drag.z, dur = C?.duration?.() || Infinity;
      const t = v.tOf(p.x);
      if (drag.part === 'body') {
        let a = Math.max(0, Math.min(dur - (o.d - o.a), o.a + (t - drag.t0)));
        if (v.snap) a = v.snap(a, e);
        const dt = Math.max(-o.a, Math.min(dur - o.d, a - o.a));
        for (const k of ['a', 'b', 'c', 'd']) z[k] = o[k] + dt;
      } else if (drag.part === 'a') {
        const a = Math.max(0, Math.min(o.d - MIN_ZOOM, v.snap ? v.snap(t, e) : t));
        z.a = a; z.b = Math.min(a + (o.b - o.a), (a + o.d) / 2); z.c = Math.max(o.c, z.b);
      } else if (drag.part === 'd') {
        const d = Math.min(dur, Math.max(o.a + MIN_ZOOM, v.snap ? v.snap(t, e) : t));
        z.d = d; z.c = Math.max(d - (o.d - o.c), (o.a + d) / 2); z.b = Math.min(o.b, z.c);
      } else if (drag.part === 'in') {
        z.b = Math.max(o.a + RAMP_MIN, Math.min(o.a + RAMP_MAX, o.c, t));
      } else if (drag.part === 'out') {
        z.c = Math.min(o.d - RAMP_MIN, Math.max(o.d - RAMP_MAX, o.b, t));
      }
    },
    async up() {
      const d = drag;
      drag = null; bump();
      if (!d || !d.moved) return;
      const z = d.z, o = d.orig, r3 = (x) => Math.round(x * 1000) / 1000;
      if (d.part === 'body') await op({ op: 'move', id: d.id, dt: r3(z.a - o.a) }, { label: 'Move a zoom', quiet: true });
      else if (d.part === 'a') await op({ op: 'trim', id: d.id, a: r3(z.a) }, { label: 'Trim a zoom', quiet: true });
      else if (d.part === 'd') await op({ op: 'trim', id: d.id, d: r3(z.d) }, { label: 'Trim a zoom', quiet: true });
      else if (d.part === 'in') await op({ op: 'set', id: d.id, in: r3(z.b - z.a) }, { label: 'Zoom ease in', quiet: true });
      else await op({ op: 'set', id: d.id, out: r3(z.d - z.c) }, { label: 'Zoom ease out', quiet: true });
    },
    hover(p, r, v) {
      if (drag) return { cursor: drag.moved && drag.part === 'body' ? 'grabbing' : CURSOR[drag.part] };
      const ht = hit(p, v);
      if (!ht) return { cursor: '', title: '' };
      const z = ht.z;
      return { cursor: CURSOR[ht.part], title: `${label(z)} · ${ZOOM_TARGETS[z.target] || 'Camera'}${z.box ? ', into an area' : z.amount ? ` ${z.amount}×` : ''} · ${clock(z.a)}–${clock(z.d)}${z.status === 'proposed' ? ' · proposed by Claude' : ''}${z.why ? `\n${z.why}` : ''}\nClick to edit it · ${TIP[ht.part]} · Delete removes it` };
    },
    dbl() {},
  };

  // ---------- Keep it · No thanks over the lane ----------
  function syncKeys() {
    if (!track || !acts) return;
    const row = track.rows().find((x) => x.k === 'zooms');
    const [v0, v1] = track.view();
    const sig = `${ver}|${v0.toFixed(3)}|${v1.toFixed(3)}|${row?.y}|${row?.h}|${track.root.querySelector('.tk-lanes')?.clientWidth}`;
    if (sig === actSig) return;
    actSig = sig;
    const want = !row ? [] : list().filter((z) => z.status === 'proposed' && z.d >= v0 && z.a <= v1).map((z) => ({ key: z.id, x: Math.max(0, track.xOf(z.a)), x2: Math.min(track.xOf(v1), track.xOf(z.d)), y: row.y, h: row.h, name: label(z) }));
    syncPropActs(acts, actMap, want, (zid, a) => (a === 'keep' ? keep([zid]) : reject([zid])));
  }

  return {
    update, list, doc: () => doc, version: () => ver, label,
    bind(c) { C = c; },
    attach(t) {
      track = t; actSig = '';
      acts?.remove(); actMap = new Map();
      acts = h('<div class="prop-layer" role="group" aria-label="Claude’s proposed zooms"></div>');
      track.root.querySelector('.tk-lanes')?.append(acts);
    },
    detach() { acts?.remove(); acts = null; actMap = new Map(); track = null; },
    lane, syncKeys, sig: () => lane.sig(),
    selected: () => sel, select, deselect() { if (sel) select(null); },
    removeSel() { if (!sel) return false; const z = list().find((x) => x.id === sel); if (!z) return false; select(null); op({ op: 'delete', id: z.id }, { label: 'Delete a zoom' }); return true; },
    op, chain, keep, reject,
    // Z + a box on the picture, or the inspector's changes.
    add: (b) => op({ op: 'add', ...b }, { label: 'Zoom into an area' }),
    set: (zid, patch, o = {}) => op({ op: 'set', id: zid, ...patch }, { label: 'Change a zoom', quiet: true, ...o }),
    trim: (zid, patch) => op({ op: 'trim', id: zid, ...patch }, { label: 'Trim a zoom', quiet: true }),
  };
}
