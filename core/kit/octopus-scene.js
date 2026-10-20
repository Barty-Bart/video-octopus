// Video Octopus scene kit (kit: 3): lets the Video Octopus app pick, move, resize and keyframe the elements of a seek(t) scene, and
// applies the creator's saved edits (work/overrides.json) every time the scene is drawn, so Playwright renders get them
// too. Load it before the scene's own script: <script src="assets/octopus-scene.js"></script>.
//
// Canvas scenes: draw each movable element inside   Octopus.el('title', [x, y, w, h], () => { ...draw... })
//   [x, y, w, h] is the element's box in the current drawing coordinates (before the move). Ids are stable
//   names, unique within the scene file. Optional 4th argument: { label: 'Six stages title', ctx, in, out }.
//   in/out (seconds on the scene's timeline) say when the element is on screen: Video Octopus's scene timeline shows it
//   as a clip there (without them Video Octopus samples the scene to find out).
// HTML scenes: give movable elements data-studio="id"; the kit moves them with CSS translate/scale (and fades them
//   with filter: opacity()).
// Several layers (seek(t, 'txt'), seek(t, 'gfx')): set Octopus.layers = ['txt', 'gfx'] (bottom to top).
//
// overrides.json: { "v": 1, "scenes": { "<scene id>" | "*": { "<element id>": { "dx": 0, "dy": 40, "scale": 1.2, "keys": [...] } } } }
//   dx/dy are frame pixels, scale is around the element's centre. A scene's entry wins over "*" (every scene).
//   keys (optional): [{ "t": 23.1, "dx": 0, "dy": 0, "s": 1, "o": 0, "e": "linear" }, …] keyframes on top of the scene's
//   own animation. t = seconds on the scene's timeline (the render's), dx/dy frame pixels, s = scale (1 = as drawn),
//   o = opacity (0–1, multiplies the element's own), e = how it moves on to the next key: "ease" (default, ease in and
//   out), "linear" or "hold". Before the first key the element holds the first key's values, after the last the last's.
//   When an element has keys they replace its dx/dy/scale.
// The scene at time t is the production sheet's (work/production.json) scene whose start <= t < end.
// Kit 3 also tells Video Octopus which element an element is drawn inside (Octopus.el inside another's draw, or a
// data-studio element inside another) and which ones draw text, for the scene timeline's rows and the type bar.
(function () {
  if (window.Octopus && window.Octopus.kit >= 3) return;
  const root = new URL(window.STUDIO_ROOT || './', location.href);
  const http = location.protocol.startsWith('http');
  // Synchronous reads, so the first seek already has the moves. file:// needs Chromium's
  // --allow-file-access-from-files (the house r.cjs renderers pass it).
  function read(rel) {
    try {
      const x = new XMLHttpRequest();
      x.open('GET', new URL(rel, root).href + (http ? `?t=${Date.now()}` : ''), false);
      x.send();
      if (x.status === 200 || (x.status === 0 && x.responseText)) return JSON.parse(x.responseText);
    } catch {}
    return null;
  }
  const editing = /[?&]studio=edit\b/.test(location.search);

  // ---- keyframes ----
  const num = (v, d) => (v == null || !Number.isFinite(Number(v)) ? d : Number(v));
  const val = (k) => ({ dx: num(k.dx, 0), dy: num(k.dy, 0), s: num(k.s, 1), o: Math.max(0, Math.min(1, num(k.o, 1))) });
  const ease = (u, e) => (e === 'linear' ? u : e === 'hold' ? 0 : u < 0.5 ? 4 * u * u * u : 1 - Math.pow(-2 * u + 2, 3) / 2);
  const sorted = new WeakMap();
  function keyAt(keys, t) {
    let ks = sorted.get(keys);
    if (!ks) { ks = keys.filter((k) => k && Number.isFinite(Number(k.t))).slice().sort((a, b) => a.t - b.t); sorted.set(keys, ks); }
    if (!ks.length) return null;
    if (t <= ks[0].t) return val(ks[0]);
    for (let i = 0; i < ks.length - 1; i++) {
      const a = ks[i], b = ks[i + 1];
      if (t >= b.t) continue;
      const u = ease((t - a.t) / Math.max(1e-6, b.t - a.t), a.e), A = val(a), B = val(b);
      return { dx: A.dx + (B.dx - A.dx) * u, dy: A.dy + (B.dy - A.dy) * u, s: A.s + (B.s - A.s) * u, o: A.o + (B.o - A.o) * u };
    }
    return val(ks[ks.length - 1]);
  }

  const S = (window.Octopus = {
    kit: 3,
    editing,
    layers: window.STUDIO_LAYERS || [null],
    overrides: window.STUDIO_OVERRIDES || read('work/overrides.json') || { v: 1, scenes: {} },
    production: read('work/production.json'),
    t: 0, layer: null, scene: null, hits: [], ctx: null, stack: [],
    noKeys: false, hidden: null, measuring: false, // Video Octopus's editor only: sample without keys, hide lanes, measure what's drawn

    use(ctx) { S.ctx = ctx; return ctx; },
    sceneAt(t) {
      const list = (S.production && S.production.scenes) || [];
      const s = list.find((x) => t >= x.start && t < x.end) || (list.length && t >= list[list.length - 1].end ? list[list.length - 1] : null);
      return s ? String(s.id) : null;
    },
    override(id) {
      const o = (S.overrides && S.overrides.scenes) || {};
      return (S.scene != null && o[S.scene] && o[S.scene][id]) || (o['*'] && o['*'][id]) || null;
    },
    keyAt,
    // Where an element is at the current moment: its keys if it has them, else its fixed move.
    value(id) {
      const ov = S.override(id) || {};
      if (!S.noKeys && Array.isArray(ov.keys) && ov.keys.length) { const k = keyAt(ov.keys, S.t); if (k) return { ...k, keyed: true }; }
      return { dx: num(ov.dx, 0), dy: num(ov.dy, 0), s: num(ov.scale, 1), o: 1, keyed: false };
    },
    begin(t, layer) { S.t = t; S.layer = layer == null ? null : layer; S.scene = S.sceneAt(t); S.hits = []; S.stack = []; dom(); },
    end() { domHits(); },

    // A movable element on a canvas.
    el(id, box, draw, opts) {
      opts = opts || {};
      const g = opts.ctx || S.ctx || (S.ctx = (document.querySelector('canvas') || {}).getContext?.('2d'));
      if (!g) return draw();
      if (S.hidden && S.hidden.includes(id)) return undefined;
      const [x, y, w, h] = box, v = S.value(id);
      const cx = x + w / 2, cy = y + h / 2;
      g.save();
      try {
        // Move in frame pixels whatever the current transform is, then scale around the box centre; keys fade too.
        g.setTransform(new DOMMatrix().translate(v.dx, v.dy).multiply(g.getTransform()));
        g.translate(cx, cy); g.scale(v.s, v.s); g.translate(-cx, -cy);
        if (v.o !== 1) g.globalAlpha *= v.o;
        const F = g.getTransform();
        const pts = [[x, y], [x + w, y], [x, y + h], [x + w, y + h]].map(([px, py]) => F.transformPoint(new DOMPoint(px, py)));
        const xs = pts.map((p) => p.x), ys = pts.map((p) => p.y);
        const meas = S.measuring && opts.hit !== false ? (instrument(g), { b: null, o: 0 }) : null;
        let hit = null;
        if (opts.hit !== false && (meas || g.globalAlpha > 0.05)) {
          hit = { id, label: opts.label || id, scene: S.scene, layer: S.layer, ov: { dx: v.dx, dy: v.dy, scale: v.s, o: v.o }, keyed: v.keyed,
            ...(Number.isFinite(opts.in) && Number.isFinite(opts.out) ? { in: opts.in, out: opts.out } : {}),
            ...(S.stack.length ? { parent: S.stack[S.stack.length - 1] } : {}),
            x: Math.min(...xs), y: Math.min(...ys), w: Math.max(...xs) - Math.min(...xs), h: Math.max(...ys) - Math.min(...ys) };
          S.hits.push(hit);
        }
        if (meas) M.push(meas);
        if (opts.hit !== false) S.stack.push(id);
        try { return draw(); } finally {
          if (opts.hit !== false) S.stack.pop();
          if (meas) {
            M.splice(M.indexOf(meas), 1);
            // Measured: what this element actually painted (its box as drawn, and how opaque), or nothing at all.
            if (meas.o > 0.02 && meas.b) Object.assign(hit, { m: { x: meas.b[0], y: meas.b[1], w: meas.b[2] - meas.b[0], h: meas.b[3] - meas.b[1] }, o: meas.o, ...(meas.text ? { text: true } : {}) });
            else S.hits.splice(S.hits.indexOf(hit), 1);
          }
        }
      } finally { g.restore(); }
    },
  });

  // ---- measuring (Video Octopus's editor only): the bounds and opacity of what each element paints ----
  // The context's drawing calls are watched while an element draws: paths, rectangles, text and images add their
  // transformed bounds; the highest globalAlpha used is the element's opacity. Renders never turn this on.
  const M = [];
  function instrument(g) {
    if (g.__studioMeasure) return;
    g.__studioMeasure = true;
    const P = Object.getPrototypeOf(g);
    let path = null;
    const tp = (x, y) => { const m = g.getTransform(); return [m.a * x + m.c * y + m.e, m.b * x + m.d * y + m.f]; };
    const grow = (b, X, Y) => (b ? [Math.min(b[0], X), Math.min(b[1], Y), Math.max(b[2], X), Math.max(b[3], Y)] : [X, Y, X, Y]);
    const addPt = (x, y) => { const [X, Y] = tp(x, y); path = grow(path, X, Y); };
    const quad = (x, y, w, h) => { let b = null; for (const [px, py] of [[x, y], [x + w, y], [x, y + h], [x + w, y + h]]) { const [X, Y] = tp(px, py); b = grow(b, X, Y); } return b; };
    const paint = (b, pad = 0) => {
      if (!M.length || !b) return;
      const a = g.globalAlpha;
      if (a <= 0.003) return;
      for (const m of M) { m.o = Math.max(m.o, a); m.b = m.b ? [Math.min(m.b[0], b[0] - pad), Math.min(m.b[1], b[1] - pad), Math.max(m.b[2], b[2] + pad), Math.max(m.b[3], b[3] + pad)] : [b[0] - pad, b[1] - pad, b[2] + pad, b[3] + pad]; }
    };
    const scaleNow = () => { const m = g.getTransform(); return Math.sqrt(Math.abs(m.a * m.d - m.b * m.c)) || 1; };
    const textBox = (s, x, y) => { const t = g.measureText(String(s)); return quad(x - t.actualBoundingBoxLeft, y - t.actualBoundingBoxAscent, t.actualBoundingBoxLeft + t.actualBoundingBoxRight, t.actualBoundingBoxAscent + t.actualBoundingBoxDescent); };
    const watch = (name, fn) => { const orig = P[name]; if (typeof orig !== 'function') return; g[name] = function (...a) { try { fn(...a); } catch {} return orig.apply(this, a); }; };
    watch('beginPath', () => { path = null; });
    watch('moveTo', addPt); watch('lineTo', addPt);
    watch('rect', (x, y, w, h) => { const b = quad(x, y, w, h); path = path ? [Math.min(path[0], b[0]), Math.min(path[1], b[1]), Math.max(path[2], b[2]), Math.max(path[3], b[3])] : b; });
    watch('roundRect', (x, y, w, h) => { const b = quad(x, y, w, h); path = path ? [Math.min(path[0], b[0]), Math.min(path[1], b[1]), Math.max(path[2], b[2]), Math.max(path[3], b[3])] : b; });
    watch('arc', (x, y, r) => { const b = quad(x - r, y - r, 2 * r, 2 * r); path = path ? [Math.min(path[0], b[0]), Math.min(path[1], b[1]), Math.max(path[2], b[2]), Math.max(path[3], b[3])] : b; });
    watch('ellipse', (x, y, rx, ry) => { const r = Math.max(rx, ry), b = quad(x - r, y - r, 2 * r, 2 * r); path = path ? [Math.min(path[0], b[0]), Math.min(path[1], b[1]), Math.max(path[2], b[2]), Math.max(path[3], b[3])] : b; });
    watch('arcTo', (x1, y1, x2, y2) => { addPt(x1, y1); addPt(x2, y2); });
    watch('quadraticCurveTo', (a, b, x, y) => { addPt(a, b); addPt(x, y); });
    watch('bezierCurveTo', (a, b, c, d, x, y) => { addPt(a, b); addPt(c, d); addPt(x, y); });
    watch('fill', (p) => { if (!(p instanceof Path2D)) paint(path); });
    watch('stroke', (p) => { if (!(p instanceof Path2D)) paint(path, (g.lineWidth / 2) * scaleNow()); });
    watch('fillRect', (x, y, w, h) => paint(quad(x, y, w, h)));
    watch('strokeRect', (x, y, w, h) => paint(quad(x, y, w, h), (g.lineWidth / 2) * scaleNow()));
    // Text belongs to the innermost element drawing it (the type bar shows for elements that draw text).
    const texted = () => { if (M.length && g.globalAlpha > 0.003) M[M.length - 1].text = true; };
    watch('fillText', (s, x, y) => { texted(); paint(textBox(s, x, y)); });
    watch('strokeText', (s, x, y) => { texted(); paint(textBox(s, x, y), (g.lineWidth / 2) * scaleNow()); });
    watch('drawImage', (img, ...a) => {
      const [x, y, w, h] = a.length >= 8 ? a.slice(4, 8) : a.length >= 4 ? a.slice(0, 4) : [a[0], a[1], img.naturalWidth || img.videoWidth || img.width || 0, img.naturalHeight || img.videoHeight || img.height || 0];
      paint(quad(x, y, w, h));
    });
  }

  // HTML scenes: [data-studio] elements.
  function dom() {
    document.querySelectorAll('[data-studio]').forEach((el) => {
      const v = S.value(el.dataset.studio);
      el.style.translate = v.dx || v.dy ? `${v.dx}px ${v.dy}px` : '';
      el.style.scale = v.s !== 1 ? String(v.s) : '';
      if (v.keyed || el.dataset.studioFaded) { el.style.filter = v.o !== 1 ? `opacity(${v.o})` : ''; el.dataset.studioFaded = v.o !== 1 ? '1' : ''; }
      if (S.hidden || el.dataset.studioHidden) { const hide = Boolean(S.hidden && S.hidden.includes(el.dataset.studio)); el.style.visibility = hide ? 'hidden' : ''; el.dataset.studioHidden = hide ? '1' : ''; }
    });
  }
  function domHits() {
    document.querySelectorAll('[data-studio]').forEach((el) => {
      const r = el.getBoundingClientRect(), cs = getComputedStyle(el);
      let o = Number(cs.opacity);
      for (let p = el.parentElement; p && p !== document.body; p = p.parentElement) o *= Number(getComputedStyle(p).opacity);
      if (!r.width || !r.height || cs.visibility === 'hidden' || o < 0.05) return;
      const v = S.value(el.dataset.studio), m = { x: r.left + scrollX, y: r.top + scrollY, w: r.width, h: r.height };
      const up = el.parentElement && el.parentElement.closest('[data-studio]');
      // Text of its own: a text node right inside it, or all of its text when nothing movable sits inside it.
      const text = [...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim()) || (!el.querySelector('[data-studio], img, video, canvas, svg') && Boolean(el.textContent.trim()));
      S.hits.push({ id: el.dataset.studio, label: el.dataset.studioLabel || el.dataset.studio, scene: S.scene, layer: S.layer,
        ov: { dx: v.dx, dy: v.dy, scale: v.s, o: v.o }, keyed: v.keyed, ...m, ...(S.measuring ? { m, o: o * v.o } : {}),
        ...(up ? { parent: up.dataset.studio } : {}), ...(text ? { text: true } : {}) });
    });
  }

  // Wrap the scene's seek(t, layer) so every draw starts with begin() and ends with end().
  const wrap = (fn) => {
    if (typeof fn !== 'function' || fn.__studio) return fn;
    const w = function (t) { S.begin(t, arguments[1]); try { return fn.apply(this, arguments); } finally { S.end(); } };
    w.__studio = true;
    return w;
  };
  let seekFn = wrap(window.seek);
  try {
    Object.defineProperty(window, 'seek', { configurable: true, enumerable: true, get: () => seekFn, set: (fn) => { seekFn = wrap(fn); } });
  } catch {}
  // A `function seek(){}` declaration replaces the accessor; wrap it once the page has loaded.
  const late = () => { if (typeof window.seek === 'function' && !window.seek.__studio) window.seek = wrap(window.seek); };
  document.addEventListener('DOMContentLoaded', late);
  addEventListener('load', late);

  // In Video Octopus's editor (an iframe with ?studio=edit): draw a moment on request and report the elements.
  // The request can ask to measure what's drawn (measure), to leave keys out (noKeys: Claude's own motion) and to
  // hide elements (hidden: the timeline's eye, preview only).
  if (editing) {
    const meta = document.createElement('meta');
    meta.name = 'studio-kit'; meta.content = '3';
    document.head.append(meta);
    addEventListener('message', async (e) => {
      if (e.origin !== location.origin || !e.data || e.data.type !== 'studio:seek') return;
      const m = e.data;
      try { await window.ready; } catch {}
      late();
      if (m.overrides) S.overrides = m.overrides;
      S.measuring = Boolean(m.measure); S.noKeys = Boolean(m.noKeys); S.hidden = Array.isArray(m.hidden) && m.hidden.length ? m.hidden : null;
      let error = null;
      try { window.seek(m.t, m.layer == null ? undefined : m.layer); } catch (err) { error = String(err && err.message || err); }
      S.measuring = false; S.noKeys = false;
      parent.postMessage({ type: 'studio:drawn', req: m.req, t: m.t, layer: m.layer, scene: S.scene, hits: S.hits, error, layers: S.layers, kit: S.kit,
        size: [document.documentElement.scrollWidth, document.documentElement.scrollHeight] }, location.origin);
    });
    addEventListener('load', () => parent.postMessage({ type: 'studio:kit', layers: S.layers, kit: S.kit }, location.origin));
  }
})();
