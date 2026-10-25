// Scenes tab: the production sheet's scenes in a
// list grouped by section (the project's blocks: intro, main body…), one player for two views ("Whole video" plays
// the render in order and the list follows along; "One scene" plays the picked scene with its own timeline: words on
// the waveform, every graphic a clip), and a panel with Notes, Look (layout, background, transition, sound) and the
// Change package. Everything the creator changes here (notes, look changes, timing dragged on the timeline, an
// element's text, font or colour, moves) waits in the package until it's sent to the project's Claude in one go;
// moves and resizes also show at once in Edit graphics (the scene kit applies work/overrides.json when it draws).
import { $, h, esc, api, toast, clock, ago } from './ui.js';
import { makeTimeline } from './timeline.js';
import { makeSceneTimeline } from './scenetimeline.js';
import { makeCutTrim, cutMapper, sec } from './cuttrim.js';
import { makeCompare, previousOf, versionName } from './compare.js';
import { sandboxURL } from './sandbox-painter.js';
import { TONE_LABEL, TONE_DOT, sceneTone, sceneRow } from './scene-tone.js';

const LS = (k, v) => { try { if (v === undefined) return localStorage.getItem(k); localStorage.setItem(k, v); } catch {} return null; };
const mmss = (s) => { const m = /^(\d+):(\d+(?:\.\d+)?)$/.exec(String(s).trim()); return m ? Number(m[1]) * 60 + Number(m[2]) : null; };
const c2 = (t) => { t = Math.max(0, t || 0); const m = Math.floor(t / 60); return `${m}:${(t % 60).toFixed(2).padStart(5, '0')}`; };
const ICON = {
  play: '<svg width="11" height="12" viewBox="0 0 11 12" aria-hidden="true"><path d="M1.5 1.2l8.5 4.8-8.5 4.8z"/></svg>',
  pause: '<svg width="11" height="12" viewBox="0 0 11 12" aria-hidden="true"><path d="M2 1h2.4v10H2zM6.6 1H9v10H6.6z"/></svg>',
  edit: '<svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true"><rect x="2" y="2" width="10" height="10" rx="1.5" stroke-dasharray="2 1.6"/><path d="M9 9l3 3"/></svg>',
  pin: '<svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true"><path d="M6 11s4-3.6 4-6.5A4 4 0 0 0 2 4.5C2 7.4 6 11 6 11z"/></svg>',
  claude: '<svg class="ic-claude" width="12" height="12" viewBox="0 0 16 16" aria-hidden="true"><path d="M8 1.5v13M1.5 8h13M3.4 3.4l9.2 9.2M12.6 3.4l-9.2 9.2"/></svg>',
  caret: '<svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true"><path d="M2 3.5l3 3 3-3"/></svg>',
};
// Little layout pictures for the Look tab: boxes as % of the frame ([x, y, w, h, 'scr'|'cam']).
const LAYOUT_GLYPH = {
  'talking-head': [[8, 8, 84, 84, 'cam']], cutout: [[8, 18, 84, 30, 'scr'], [30, 30, 40, 70, 'cam']], split: [[5, 12, 55, 76, 'scr'], [64, 12, 31, 76, 'cam']],
  'visual-storytelling': [[8, 10, 84, 80, 'scr']], card: [[20, 22, 60, 56, 'scr']], boxed: [[6, 16, 56, 68, 'scr'], [66, 16, 28, 68, 'cam']],
};
const glyph = (id) => `<span class="lg" aria-hidden="true">${(LAYOUT_GLYPH[id] || [[12, 16, 76, 68, 'scr']]).map(([x, y, w, hh, k]) => `<i class="${k}" style="left:${x}%;top:${y}%;width:${w}%;height:${hh}%"></i>`).join('')}</span>`;
const FIELD_NAME = { layout: 'Layout', background: 'Background', transition: 'Transition in', sfx: 'Sound', timing: 'Timing', style: 'Type', text: 'Text', enter: 'Enters', leave: 'Leaves', level: 'Sound level' }; // cut, blocks, look: their own sentence
const FIELD_ICON = { layout: '▦', background: '▧', transition: '◐', sfx: '♪', timing: '⇥', style: 'Aa', text: 'T', cut: '✂', blocks: '▤', look: '◑', enter: '↗', leave: '↘', level: '♪' };
// How an element comes on and goes off screen (the element panel's Enters / Leaves): a change for Claude to animate.
const MOTIONS = [['', 'As made'], ['cut', 'Cut'], ['fade', 'Fade'], ['rise', 'Rise'], ['drop', 'Drop'], ['slide-left', 'Slide left'], ['slide-right', 'Slide right'], ['scale', 'Scale'], ['pop', 'Pop'], ['wipe', 'Wipe'], ['type', 'Type on']];
const LEVELS = [-18, -15, -12, -9, -6, -3, 0, 3, 6];
// Where the camera is in each layout (the scene timeline's Camera lane).
const CAMERA_OF = { 'talking-head': 'Camera full frame', cutout: 'Camera cut out over the graphics', split: 'Camera card · right third', boxed: 'Camera card · box', 'visual-storytelling': 'No camera (voice over the graphics)', card: 'No camera (a card)' };
const LAYOUT_NAME = { 'talking-head': 'Talking head', cutout: 'Cutout', split: 'Split', boxed: 'Boxed', 'visual-storytelling': 'Storytelling', card: 'Card' };
const TEXTY = /title|text|caption|label|head|word|name|quote|type|line|cta|subtitle|kicker|tag/i;
const STYLE_COLORS = [['#F2EDE4', 'Ivory'], ['#E8742F', 'Orange'], ['#FFFFFF', 'White'], ['#8A8577', 'Grey'], ['#1A1A1C', 'Ink']];
const FONTS = ['Geist', 'Geist Mono', 'Caveat'];
const WEIGHTS = [['400', 'Regular'], ['700', 'Bold'], ['900', 'Black']];
const SRC_LABEL = { look: 'from the Look tab', timeline: 'from the timeline', picture: 'from the picture', element: 'from the element panel', scene: 'note', render: 'note', canvas: 'note on the canvas' };
const showVal = (v) => (v == null || v === '' ? 'none' : typeof v === 'number' ? c2(v)
  : typeof v === 'object' ? Object.entries(v).map(([k, x]) => (/^(start|end|in|out|t)$/.test(k) && typeof x === 'number' ? `${k} ${c2(x)}` : k === 'color' ? `colour ${x}` : `${k} ${x}`)).join(', ') : String(v));

// A change's before/after in a few characters: a time range reads 0:00.0 – 0:01.7, the rest as showVal.
const shortVal = (v) => {
  if (v && typeof v === 'object') {
    const [a, b] = v.start != null ? [v.start, v.end] : v.in != null ? [v.in, v.out] : [];
    if (typeof a === 'number' && typeof b === 'number') return `${c2(a)} – ${c2(b)}`;
  }
  return showVal(v);
};

// Locked cut ⇄ source time: the production sheet (and the renders) run on the cut; the canvas plays the take.
// (web/layout.js cutMap, shared with the shots' look functions and the export.)
export { cutMap } from './layout.js';

// Keyframes: the same maths as the scene kit (core/kit/octopus-scene.js keyAt), so outlines and panels match the picture.
const easeK = (u, e) => (e === 'linear' ? u : e === 'hold' ? 0 : u < 0.5 ? 4 * u * u * u : 1 - Math.pow(-2 * u + 2, 3) / 2);
export function keyAt(keys, t) {
  const ks = [...keys].sort((a, b) => a.t - b.t), val = (k) => ({ dx: k.dx || 0, dy: k.dy || 0, s: k.s ?? 1, o: k.o ?? 1 });
  if (!ks.length) return { dx: 0, dy: 0, s: 1, o: 1 };
  if (t <= ks[0].t) return val(ks[0]);
  for (let i = 0; i < ks.length - 1; i++) {
    const a = ks[i], b = ks[i + 1];
    if (t >= b.t) continue;
    const u = easeK((t - a.t) / Math.max(1e-6, b.t - a.t), a.e), A = val(a), B = val(b);
    return { dx: A.dx + (B.dx - A.dx) * u, dy: A.dy + (B.dy - A.dy) * u, s: A.s + (B.s - A.s) * u, o: A.o + (B.o - A.o) * u };
  }
  return val(ks.at(-1));
}

// ◇ where a graphic's motion changes: its measured box (centre, size) and opacity over the scene, simplified to its
// turning points (Ramer–Douglas–Peucker; 6 px or 5% opacity counts as a change). Each gets what happens there.
export function motionMarks(pts, dt) {
  const ch = (p) => [(p.x + p.w / 2) / 6, (p.y + p.h / 2) / 6, p.w / 6, p.h / 6, p.o / 0.05];
  const runs = [];
  let run = [];
  for (const p of pts) { if (run.length && p.t - run.at(-1).t > dt * 1.6) { runs.push(run); run = []; } run.push(p); }
  if (run.length) runs.push(run);
  const verb = (d) => { const m = d.map(Math.abs), k = m.indexOf(Math.max(...m)); return k === 4 ? (d[4] > 0 ? 'fade in' : 'fade out') : k >= 2 ? (d[k] > 0 ? 'grow' : 'shrink') : 'move'; };
  const ing = (w) => ({ 'fade in': 'fading in', 'fade out': 'fading out', grow: 'growing', shrink: 'shrinking', move: 'moving' }[w]);
  const done = (w) => ({ 'fade in': 'fully faded in', 'fade out': 'faded out', grow: 'stops growing', shrink: 'stops shrinking', move: 'settles' }[w]);
  const s3 = (w) => ({ 'fade in': 'fades in', 'fade out': 'fades out', grow: 'grows', shrink: 'shrinks', move: 'moves' }[w]);
  const out = [];
  for (const r of runs) {
    if (r.length < 3) continue;
    const v = r.map(ch), keep = new Set();
    const rdp = (a, b) => {
      let worst = 1, wi = -1;
      for (let i = a + 1; i < b; i++) {
        const u = (r[i].t - r[a].t) / (r[b].t - r[a].t);
        let d = 0;
        for (let c = 0; c < 5; c++) d = Math.max(d, Math.abs(v[i][c] - (v[a][c] + (v[b][c] - v[a][c]) * u)));
        if (d > worst) { worst = d; wi = i; }
      }
      if (wi > 0) { keep.add(wi); rdp(a, wi); rdp(wi, b); }
    };
    rdp(0, r.length - 1);
    const idx = [0, ...[...keep].sort((a, b) => a - b), r.length - 1];
    for (let j = 1; j < idx.length - 1; j++) {
      const [a, i, b] = [idx[j - 1], idx[j], idx[j + 1]];
      // What changes on the way in and on the way out (to the neighbouring turning points); under 1 unit is still.
      const din = v[i].map((x, c) => x - v[a][c]), dout = v[b].map((x, c) => x - v[i][c]), still = (d) => Math.max(...d.map(Math.abs)) < 1;
      const what = still(din) && !still(dout) ? `starts to ${verb(dout)}` : !still(din) && still(dout) ? done(verb(din))
        : verb(din) === verb(dout) ? `${ing(verb(din))}: changes speed or direction` : `${ing(verb(din))}, then ${s3(verb(dout))}`;
      out.push({ t: r[i].t, x: r[i].x, y: r[i].y, w: r[i].w, h: r[i].h, o: r[i].o, what });
    }
  }
  // Close ones merge (the first stays); a busy element keeps its first 16.
  return out.filter((m, i) => i === 0 || m.t - out[i - 1].t > 0.12).slice(0, 16);
}

// The scene's HTML, one iframe per layer stacked bottom to top, drawn at a moment through the scene kit.
const sceneWord = (v) => typeof v === 'string' ? v.slice(0, 300) : null;
function sceneReply(data) {
  const box = (o) => o && ['x', 'y', 'w', 'h'].every((k) => Number.isFinite(o[k]) && Math.abs(o[k]) <= 1e7)
    ? Object.fromEntries(['x', 'y', 'w', 'h'].map((k) => [k, o[k]])) : null;
  const hits = (Array.isArray(data.hits) ? data.hits : []).slice(0, 5000).flatMap((v) => {
    const b = box(v), id = sceneWord(v?.id); if (!b || !id) return [];
    const h = { ...b, id, label: sceneWord(v.label) || id, scene: sceneWord(v.scene), layer: sceneWord(v.layer), parent: sceneWord(v.parent), keyed: Boolean(v.keyed), text: Boolean(v.text) };
    if (box(v.m)) h.m = box(v.m);
    for (const k of ['in', 'out', 'o']) if (Number.isFinite(v[k])) h[k] = v[k];
    if (v.ov) h.ov = Object.fromEntries(['dx', 'dy', 'scale', 'o'].filter((k) => Number.isFinite(v.ov[k])).map((k) => [k, v.ov[k]]));
    return [h];
  });
  return { type: 'studio:drawn', req: data.req, t: data.t, layer: sceneWord(data.layer), scene: sceneWord(data.scene), hits,
    error: sceneWord(data.error), kit: Number.isInteger(data.kit) ? data.kit : 0,
    layers: (Array.isArray(data.layers) ? data.layers : [null]).slice(0, 100).map(sceneWord),
    size: Array.isArray(data.size) && data.size.length === 2 && data.size.every((v) => Number.isFinite(v) && v >= 0 && v <= 1e7) ? data.size : [0, 0] };
}
class SceneFrames {
  constructor(host, { src, layers, frame }) {
    this.W = frame[0]; this.H = frame[1];
    this.host = host;
    this.wrap = h(`<div class="sf-wrap" aria-hidden="true"></div>`);
    Object.assign(this.wrap.style, { width: `${this.W}px`, height: `${this.H}px` });
    host.append(this.wrap);
    const source = sandboxURL(src, 'scene');
    this.frames = (layers?.length ? layers : [null]).map((layer) => {
      const f = h(`<iframe class="sf" sandbox="allow-scripts" referrerpolicy="no-referrer" tabindex="-1" title="Scene"></iframe>`);
      Object.assign(f.style, { width: `${this.W}px`, height: `${this.H}px` });
      this.wrap.append(f);
      const ready = source.then((url) => new Promise((res, rej) => {
        if (this.dead) return res();
        const timer = setTimeout(() => rej(new Error('The scene did not load in 15 seconds.')), 15000);
        f.addEventListener('load', () => { clearTimeout(timer); res(); }, { once: true });
        f.src = url;
      }));
      ready.catch(() => {}); // draw() reports the failure when this layer is requested.
      return { layer, f, ready };
    });
    this.req = 0;
    this.waiting = new Map();
    this.onMsg = (e) => {
      if (e.origin !== 'null' || e.data?.type !== 'studio:drawn') return;
      const done = this.waiting.get(e.data.req);
      if (done && e.source === done.source) { this.waiting.delete(e.data.req); clearTimeout(done.timer); done.resolve(sceneReply(e.data)); }
    };
    addEventListener('message', this.onMsg);
    this.ro = new ResizeObserver(() => this.fit());
    this.ro.observe(host);
    this.fit();
  }
  fit() { const w = this.host.clientWidth; if (w) this.wrap.style.transform = `scale(${w / this.W})`; }
  // extra: { measure, noKeys, hidden } for the kit (kit 2): measure what's drawn, leave keys out, hide elements.
  async draw(t, overrides, extra = {}) {
    await Promise.all(this.frames.map((x) => x.ready));
    if (this.dead) return [];
    const out = await Promise.all(this.frames.map(({ layer, f }) => new Promise((res) => {
      const req = crypto.randomUUID();
      const timer = setTimeout(() => { if (this.waiting.delete(req)) res(null); }, 6000);
      this.waiting.set(req, { source: f.contentWindow, resolve: res, timer });
      try { f.contentWindow.postMessage({ ...extra, type: 'studio:seek', t, layer, overrides, req }, '*'); }
      catch { this.waiting.delete(req); clearTimeout(timer); res(null); }
    })));
    return out.filter(Boolean);
  }
  destroy() { this.dead = true; for (const w of this.waiting.values()) { clearTimeout(w.timer); w.resolve(null); } this.waiting.clear(); removeEventListener('message', this.onMsg); this.ro.disconnect(); this.wrap.remove(); }
}

// empty(why): the empty state when there are no scenes yet (web/rail.js: which step makes them, the way there).
export function makeScenes({ pane, inspector, id, getP, onCount, onScenes, history, openCut, empty }) {
  const enc = encodeURIComponent(id);
  const media = (f) => `/api/projects/${enc}/media?f=${encodeURIComponent(f)}`;
  // Where the cut's joins sit on the timeline the sheet and renders use (the server's snapshot of that cut,
  // work/cut_scenes.json): red lines on the scene timelines; clicking one opens it in the Cut tab.
  const cutJoins = () => { const segs = D?.cutScenes || getP()?.export?.cut?.segments || [], out = []; let d = 0; for (let i = 0; i < segs.length - 1; i++) { d += segs[i][1] - segs[i][0]; out.push(Math.round(d * 100) / 100); } return out; };
  // The render with its time as a cache key, so a rewritten file never plays from the cache.
  const renderUrl = () => `${media(renderFile)}&v=${Math.round(D.renders.find((r) => r.file === renderFile)?.at || 0)}`;
  // A video that fails to open (a file that was still being written) tries again a few times.
  const retry = (v, url) => {
    v.addEventListener('error', () => {
      const n = Number(v.dataset.tries || 0);
      if (n >= 4 || !v.getAttribute('src')) return;
      v.dataset.tries = n + 1;
      setTimeout(() => { if (v.getAttribute('src')) { v.src = `${url()}&r=${n + 1}`; v.load(); } }, 1500 * (n + 1));
    });
  };
  let D = null;                                  // GET /scenes
  let mode = LS('studio.scenes.mode') === 'full' ? 'full' : 'scene';
  let renderFile = null, sel = null, noteSel = null, elSel = null;
  let tab = 'notes', pkgFilter = 'waiting';
  let pin = null;                                // a spot picked on the picture, waiting for its note text
  let replyTo = null;
  let editing = false, edSel = null, edHits = [], edScope = 'scene', frames = null, probe = null;
  const pendingOv = new Map(), saveTimers = new Map();
  let built = '', active = false, loadSeq = 0, changes = 0;
  let newest = null;                             // the newest render last time: a new one is shown by itself
  let player = null;                             // the one player for both views
  let raf = 0;
  let loopScene = LS('studio.scenes.loop') === '1', pauseAtEnd = LS('studio.scenes.pauseAtEnd') === '1', playingScene = null;
  let peaks = null, peaksFor = null;
  const thumbs = new Map(); let thumbsFor = null, thumbJob = 0;
  const folded = new Set(JSON.parse(LS(`studio.scenes.folded.${id}`) || '[]'));
  let samples = { key: '', state: 'none', times: [], hits: [], clips: [] }, sampleJob = 0;
  let hoverEl = null;                            // a graphic hovered on the scene timeline: outlined on the picture
  let preview = { key: '', text: '' };
  let firstScene = null;                         // "Show me scene N first" in the package
  let cmp = null, cmpDown = 0, cmpHeld = false;  // compare with the previous render (C: tap toggles the line, hold shows it full)
  let stamp = null;                              // the cut files as the take was last read
  const listFold = { full: LS('studio.scenes.strip.full') === '1', scene: LS('studio.scenes.strip.scene') !== '0' }; // the list as a numbered strip
  // Pulling a cut inside a scene, and the trim lens (web/cuttrim.js): the same cut as the Cut tab and the package.
  const trim = makeCutTrim({
    project: id, history,
    snapshot: () => D?.cutScenes || null,
    opts: () => ({ hl: Boolean(getP()?.editing?.trimHighlight), lens: Boolean(getP()?.editing?.trimLens) }),
    frame: () => (player ? { take: player.take, take2: player.take2, label: player.trimL, insetLabel: player.trimIL } : null),
    scrubbing: (on) => { if (!player) return; if (on) ensureTake2(); player.frame.classList.toggle('trimming', on); applyView(); },
    changed: () => { if (!player) return; ensureTake(); if (mode === 'scene') player.stl.render(); else { player.tl.setData({ words: D.words, peaks: wholePeaks(), note: `${D.scenes.length} scenes · ${D.words.length} words` }); player.tl.track.redraw(); } applyView(); },
    saved: async () => { changes++; await update(); },
    openCut: (t) => openCut?.(t),
    lensSpot: (kind, t) => lensSpot(kind, t),
    wholeCuts: () => wholeCuts(),
  });
  const bandScene = trim.band('scene', () => axNow()), bandWhole = trim.band('whole');

  // ---------- data ----------
  const scene = (sid) => D?.scenes.find((s) => s.id === sid) || null;
  const sceneAt = (t) => D.scenes.find((s) => t >= s.start && t < s.end) || (t >= D.scenes.at(-1).end ? D.scenes.at(-1) : D.scenes[0]);
  const sectionOf = (sid) => (D.sections || []).find((g) => g.scenes.includes(sid)) || null;
  const notesOf = (sid) => D.notes.filter((n) => n.scene === sid);
  const realNotes = (sid) => notesOf(sid).filter((n) => n.kind !== 'change');
  const numberOf = (n) => realNotes(n.scene).indexOf(n) + 1;
  const openItems = () => D.notes.filter((n) => n.status === 'open');
  const openChange = (sid, field, target = null) => D.notes.find((n) => n.kind === 'change' && n.status === 'open' && n.scene === sid && n.field === field && (n.target?.id || '') === (target || ''));
  const renderAt = () => D.renders.find((r) => r.file === renderFile)?.at || 0;
  // How far the picked render reaches on the sheet's timeline (renders start at its 0:00; an intro render stops after the
  // intro): the scenes after that play the take. builtSc: a scene some render has built (server builtEnd); only those
  // can be approved, the rest say "Not built yet".
  const renderEnd = () => { const d = D.renders.find((r) => r.file === renderFile)?.duration || (Number.isFinite(player?.v.duration) ? player.v.duration : 0); return d > 0 ? d : Infinity; };
  const reaches = (s) => Boolean(renderFile && s && s.start < renderEnd() - 0.1);
  const builtSc = (s) => Boolean(s && (D.builtEnd ?? Infinity) > s.start + 0.1);
  const newMoveList = () => Object.entries(D.overrides?.scenes || {}).flatMap(([scn, els]) => Object.entries(els).filter(([, o]) => !o.at || Date.parse(o.at) > renderAt()).map(([el, o]) => ({ scene: scn, el, o })));
  const packageCount = () => openItems().length + newMoveList().length;
  // The picked render reaches this scene (no render picked: nothing to show it in, so it doesn't count as outside it).
  const inRender = (s) => !renderFile || reaches(s);
  // web/scene-tone.js: a scene the picked render doesn't reach (an intro-only build) is "Not in this build" (B5a).
  const toneOf = (s) => sceneTone({ approved: Boolean(D.approved[s.id]), notes: notesOf(s.id).filter((n) => n.status !== 'resolved'), built: builtSc(s), inRender: inRender(s) });
  const toneText = (s, tone = toneOf(s)) => {
    if (tone !== 'notes') return TONE_LABEL[tone];
    const k = realNotes(s.id).filter((n) => n.status === 'open').length;
    return `${k} note${k > 1 ? 's' : ''}`;
  };

  // A newer load wins, and a load that started before a change made here is fetched again. true once D is this load's
  // (a load a newer one overtook says false: that one's caller draws).
  async function load() {
    const my = ++loadSeq, c0 = changes;
    let d;
    try { d = await api(`/api/projects/${enc}/scenes`); } catch (e) { if (!active || my !== loadSeq) return false; throw e; } // left meanwhile: nothing to say
    if (my !== loadSeq) return false;
    if (c0 !== changes) return load();
    D = d;
    if (D.ready) {
      D.overrides = withPending(D.overrides);
      // The cut changed on disk (a save here, the Cut tab, Claude): read the take again.
      if (D.cutScenes && stamp !== D.cutStamp) { stamp = D.cutStamp; trim.load(true); }
      // A render Claude just made is shown by itself; otherwise the picked one stays.
      const top = D.renders[0]?.file || null;
      const keep = renderFile || LS(`studio.scenes.render.${id}`);
      renderFile = newest !== null && top !== newest ? top : D.renders.some((r) => r.file === keep) ? keep : top;
      newest = top;
      if (!scene(sel)) sel = D.scenes[0].id;
      preview.key = '';
    }
    // The plan waits for the creator's OK (B4): the panel opens on Plan by itself, once.
    if (D.ready && planWaiting() && !planShown) { planShown = true; if (tab === 'notes' || tab === 'look') tab = 'plan'; }
    if (!planWaiting()) planShown = false;
    onCount?.(D.ready ? { count: D.scenes.length, open: packageCount(), done: D.notes.filter((n) => n.status === 'done' || n.status === 'question').length } : null);
    onScenes?.(D.ready ? D : null);
    return true;
  }
  // Apply what the server answered to a change made here.
  const took = (doc) => { changes++; if (doc.notes) { D.notes = doc.notes; D.approved = doc.approved; } preview.key = ''; return doc; };

  async function update() {
    if (!(await load()) || !active || !D) return;
    build();
  }

  // ---------- the pane: list · player (+ one of two timelines) ----------
  function build() {
    if (!D.ready) {
      teardownMedia(); built = 'blank';
      pane.replaceChildren(empty?.(D.why) || h(`<div class="blank"><h3>No scenes yet</h3><div>${esc(D.why)}</div></div>`));
      renderInspector();
      return;
    }
    const sig = JSON.stringify([renderFile, D.scenes.map((s) => [s.id, s.start, s.end, s.title]), D.frame]);
    if (sig !== built) { built = sig; buildPane(); }
    if (renderFile && peaksFor !== renderFile) loadPeaks();
    if (renderFile && thumbsFor !== renderFile) captureThumbs();
    paint();
  }

  function buildPane() {
    teardownMedia();
    const [W, H] = D.frame;
    const el = h(`<div class="s2">
      <nav class="s2-list" aria-label="Scenes"><div class="s2-lh"></div><div class="s2-groups" role="list"></div></nav>
      <div class="s2-main">
        <div class="s2-top">
          <div class="seg" id="s2Mode" role="group" aria-label="View"><button data-m="full">Whole video</button><button data-m="scene">One scene</button></div>
          <div class="s2-title"></div><span class="gap"></span>
          ${D.renders.length ? `<label class="sc-render"><span class="vh">Render</span><select id="scRender">${D.renders.map((r) => `<option value="${esc(r.file)}"${r.file === renderFile ? ' selected' : ''}>${esc(r.file.replace(/^renders\//, ''))} · ${esc(ago(r.at))}</option>`).join('')}</select></label>` : ''}
          <button class="btn ghost small" id="s2Prev" aria-label="Previous scene" title="Previous scene (↑)">↑</button><button class="btn ghost small" id="s2Next" aria-label="Next scene" title="Next scene (↓)">↓</button>
          <button class="btn small s2-pkg" id="s2Pkg" title="Everything waiting for Claude"><span class="lbl">Change package</span><span class="lbl-s">Package</span> <span class="n" id="s2PkgN"></span></button>
        </div>
        <div class="sc-stage"><div class="sc-frame big" style="--ar:${W / H}">
          <video class="sc-v" preload="auto" playsinline></video>
          <video class="sc-take" preload="auto" playsinline></video>
          <video class="sc-under" preload="auto" playsinline muted hidden></video>
          <div class="sc-trim" aria-hidden="true"><span class="sc-trim-l"></span><div class="sc-trim-in"><video class="sc-take2" muted preload="auto" playsinline></video><span></span></div></div>
          <span class="sc-cutnote" hidden>The new cut · the take plays here until Claude re-renders this scene</span>
          <div class="sc-edit" hidden><div class="sf-host"></div><div class="eb-layer"></div></div>
          <div class="sc-els"></div>
          <div class="sc-pins"></div>
          <span class="sc-none" hidden>No render yet: the scene's own graphics show in Edit graphics</span>
        </div></div>
        <div class="transport">
          <button class="play" id="scPlay" aria-label="Play"><i></i></button>
          <span class="time" id="scTime">0:00.0</span>
          <span class="sc-now" id="scNow"></span>
          <span class="gap"></span>
          <span class="sc-keys sub" id="scKeys" title="Space play · ↑ ↓ scenes · N note · A approve · C compare (hold: the render before, full)"><span class="k-l">Space play · ↑ ↓ scenes · N note · A approve · C compare</span><span class="k-s">Space · ↑↓ · N · A · C</span></span>
          <button class="btn ghost small" id="scCmp" hidden title="Compare with the previous render at the same moment (C; hold C to see it full)"></button>
          <label class="toggle" id="scLoopW"><input type="checkbox" role="switch" id="scLoop"><span class="sw" aria-hidden="true"></span><span id="scLoopL"></span></label>
          <button class="btn small" id="scEdit" title="Move and resize this scene's titles and cards (E)" aria-label="Edit graphics">${ICON.edit}<span class="lbl">Edit graphics</span></button>
        </div>
        <div class="s2-split" id="s2Split" role="separator" aria-orientation="horizontal" aria-label="Timeline height" tabindex="0" title="Drag up for the whole timeline, down for a bigger picture · double-click to fold"><i></i></div>
        <div class="timeline" id="scTl"></div>
        <div class="stl-host" id="scStl"></div>
      </div></div>`);
    pane.replaceChildren(el);
    const v = $('.sc-v', el), under = $('.sc-under', el), frame = $('.sc-frame', el);
    player = { el, v, under, frame, pins: $('.sc-pins', el), els: $('.sc-els', el), edit: $('.sc-edit', el), boxes: $('.eb-layer', el), sfHost: $('.sf-host', el), none: $('.sc-none', el),
      play: $('#scPlay', el), time: $('#scTime', el), now: $('#scNow', el), t: 0, list: $('.s2-groups', el), lh: $('.s2-lh', el), title: $('.s2-title', el),
      take: $('.sc-take', el), take2: $('.sc-take2', el), trimL: $('.sc-trim-l', el), trimIL: $('.sc-trim-in span', el), cutNote: $('.sc-cutnote', el) };
    // The take (the new cut plays from it, and a pull shows its frames): the play button follows it too.
    for (const x of ['play', 'pause']) player.take.addEventListener(x, () => { if (!player || !cutView()) return; const on = !player.take.paused; player.play.classList.toggle('on', on); player.play.setAttribute('aria-label', on ? 'Pause' : 'Play'); });
    viewWas = false; viewScene = null;
    ensureTake();
    cmp = makeCompare(frame, { main: () => player?.v });
    $('#scCmp', el).onclick = () => compare(cmp?.mode() ? null : 'split');
    retry(v, renderUrl);
    if (renderFile) v.src = renderUrl();
    // Whole video runs the whole sheet, also where the render stops (an intro render): the take plays on from there.
    const dur = () => Math.max(D.scenes.at(-1).end, v.duration && Number.isFinite(v.duration) ? v.duration : 0);
    player.play.onclick = () => togglePlay();
    v.addEventListener('play', () => { player.play.classList.add('on'); player.play.setAttribute('aria-label', 'Pause'); pin = null; playingScene = sceneAt(v.currentTime)?.id; renderInspector(); });
    v.addEventListener('pause', () => { if (cutView()) return; player.play.classList.remove('on'); player.play.setAttribute('aria-label', 'Play'); paintEls(true); });
    // Whole video: the render ends where the built part does (an intro); the take plays on through the cut from there.
    v.addEventListener('ended', () => {
      if (mode !== 'full' || editing || !player || pauseAtEnd || D.scenes.at(-1).end <= renderEnd() + 0.1) return;
      seekTo(renderEnd() + 1e-3);
      if (cutView()) playTake();
    });
    v.addEventListener('seeked', () => paintEls(true));
    $('#scEdit', el).onclick = () => (editing ? stopEditing() : startEditing());
    $('#s2Prev', el).onclick = () => step(-1);
    $('#s2Next', el).onclick = () => step(1);
    $('#s2Pkg', el).onclick = () => { elSel = null; setTab('package'); };
    el.querySelectorAll('#s2Mode button').forEach((b) => (b.onclick = () => setMode(b.dataset.m)));
    const rs = $('#scRender', el);
    if (rs) rs.onchange = () => { renderFile = rs.value; LS(`studio.scenes.render.${id}`, renderFile); built = ''; build(); };
    $('#scLoop', el).onchange = (e) => {
      if (mode === 'scene') { loopScene = e.target.checked; LS('studio.scenes.loop', loopScene ? '1' : '0'); }
      else { pauseAtEnd = e.target.checked; LS('studio.scenes.pauseAtEnd', pauseAtEnd ? '1' : '0'); }
    };
    frame.addEventListener('click', (e) => { if (!editing) pickOnPicture(e); });
    player.tl = makeTimeline($('#scTl', el), {
      trackId: 'whole', project: id, undo: history, toast, play: () => togglePlay(true), pause: () => pauseAll(), media: () => (editing ? player.under : cutView() ? player.take : player.v),
      cuts: cutJoins, cutsWaiting: () => D?.cutWaiting || [], openCut,
      // Pressing a cut opens the trim lens right above it (web/cuttrim.js); later scenes shift while it's open.
      cutBand: () => (trim.ready() ? bandWhole : null), cutActive: () => (trim.lensAt()?.kind === 'whole' ? trim.lensAt().t : null),
      keyGuard: (e) => editing && edSel && e.key.startsWith('Arrow'),
      duration: dur, time: () => playerTime(), playing: () => isPlaying(), seek: (t) => seekTo(t),
      sections: () => (D.sections || []).map((g) => ({ ...g, on: g.scenes.includes(sel) })),
      scenes: () => { const m = lensShift(), lt = trim.lensAt()?.kind === 'whole' ? trim.lensAt().t : null; return D.scenes.map((s) => ({ id: s.id, n: s.n, start: m(s.start), end: m(s.end), title: s.title, on: s.id === sel, trim: lt != null && lt > s.start + 1e-3 && lt <= s.end + 1e-3, tone: toneOf(s) === 'none' ? '' : toneOf(s) === 'waiting' ? 'notes' : toneOf(s) })); },
      notes: () => D.notes.filter((n) => n.t != null && n.kind !== 'change').map((n) => ({ id: n.id, t: n.t, n: numberOf(n), tone: n.status, on: n.id === noteSel })),
      pickScene: (sid) => select(sid), pickNote: (nid) => { noteSel = nid; const n = D.notes.find((x) => x.id === nid); if (n) select(n.scene); setTab('notes'); },
      openScene: (sid) => { select(sid); setMode('scene'); },
      sig: () => [sel, noteSel, D.notes.map((n) => n.id + n.status).join(), Object.keys(D.approved).join(), trim.version(), trim.lensAt()?.i].join('/'),
    });
    player.tl.setData({ words: D.words, peaks: wholePeaks(), note: `${D.scenes.length} scenes · ${D.words.length} words` });
    // The scene timeline is on the view (axNow): the cut as it is now, with the scene's start kept in place.
    const toV = (t) => axNow().toView(t);
    player.stl = makeSceneTimeline($('#scStl', el), {
      scene: () => sceneView(), words: () => (trim.ready() ? trim.words(axNow()) : D.words), peaks: () => (cutView() ? waveView() : peaksFor === renderFile ? peaks : null),
      clips: () => clipsView(sel), beats: () => beatsOf(scene(sel)).map((b) => ({ ...b, t: toV(b.t) })), sfx: () => sfxOf(scene(sel)).map((x) => ({ ...x, t: x.t == null ? null : toV(x.t) })),
      camera: () => cameraOf(scene(sel)), neighbours: () => neighbours(),
      cuts: () => (trim.ready() ? axNow().joins.map((j) => j.t) : cutJoins()), cutsWaiting: () => (trim.ready() ? [] : D?.cutWaiting || []), openCut,
      cutBand: () => (trim.ready() && !editing ? bandScene : null), trim: () => trimMarks(), sig: () => `${trim.version()}|${cutView() ? 1 : 0}`,
      notes: () => realNotes(sel).filter((n) => n.t != null && n.status !== 'resolved').map((n) => ({ id: n.id, t: toV(n.t), n: numberOf(n), tone: n.status, on: n.id === noteSel })),
      edgeWaiting: () => { const c = openChange(sel, 'timing'); return c?.to?.start != null ? { start: toV(c.to.start), end: toV(c.to.end) } : null; },
      time: () => viewTime(), playing: () => isPlaying(), seek: (t) => seekView(t),
      play: () => togglePlay(true), pause: () => pauseAll(), media: () => (editing ? player.under : cutView() ? player.take : player.v),
      pickClip: (eid, keep) => pickElement(eid, keep), pickNote: (nid) => { noteSel = nid; const n = D.notes.find((x) => x.id === nid); if (n?.t != null) seekTo(n.t); setTab('notes'); },
      edge: (e) => edgeChange(e), askKit: () => askKit(), updateKit: () => ensureKit(true),
      hover: (eid) => { hoverEl = eid; paintEls(true); if (editing) paintBoxes(); },
      hideEl: () => { paintEls(true); if (editing) redraw(); },
      keys: { move: (l) => moveKeys(l.map((x) => ({ ...x, to: axNow().toOld(x.to) }))), remove: removeKeys, duplicate: duplicateKeys },
      project: id, undo: history, toast, keyGuard: (e) => editing && edSel && e.key.startsWith('Arrow'),
    });
    const sp = $('#s2Split', el);
    sp.addEventListener('pointerdown', splitDrag);
    sp.addEventListener('dblclick', () => setTlh(player.el.classList.contains('tl-folded') ? lastOpen[mode] || 'max' : 'fold'));
    sp.addEventListener('keydown', (e) => {
      const f = fitTl(); if (!f) return;
      if (e.key === 'Enter') { e.preventDefault(); sp.dispatchEvent(new Event('dblclick')); return; }
      const k = { ArrowUp: f.hpx + 32, ArrowDown: f.hpx - 32, Home: 'fold', End: 'max' }[e.key];
      if (k === undefined) return;
      e.preventDefault(); setTlh(typeof k === 'string' ? k : k <= f.b.fold ? 'fold' : k >= f.max ? 'max' : String(Math.round(k)));
    });
    player.ro = new ResizeObserver(() => fitTl());
    for (const x of [$('.s2-main', el), ...el.querySelectorAll('.tk-canvas, .stl-notice')]) if (x) player.ro.observe(x);
    const s = scene(sel);
    if (s) seekTo(s.start + Math.min((s.end - s.start) * 0.4, 2));
    applyMode();
    const loop = () => {
      raf = requestAnimationFrame(loop);
      if (!player) return;
      // Cut view: the take plays through the cut as it is now (skipping what's cut); One scene loops or stops at the
      // scene's end, Whole video at the end of the sheet.
      if (cutView() && !trimming()) {
        const tk = player.take, ax = tax(), cs = scene(sel);
        if (!tk.paused && ax.N && cs) {
          if (!ax.N.kept(tk.currentTime)) { const nx = ax.N.next(tk.currentTime); if (nx == null) tk.pause(); else tk.currentTime = nx; }
          if (mode === 'scene') {
            const ve = ax.toView(cs.end);
            if (ax.srcToView(tk.currentTime) >= ve - 0.02) { if (loopScene) tk.currentTime = ax.viewToSrc(cs.start); else { tk.pause(); tk.currentTime = ax.viewToSrc(ve - 0.04); } }
          } else if (ax.toOld(ax.srcToView(tk.currentTime)) >= D.scenes.at(-1).end - 0.02) tk.pause();
        }
        player.t = ax.toOld(viewTime());
      }
      applyView();
      const t = playerTime();
      const cur = scene(sel);
      if (isPlaying() && !editing && cur) {
        if (mode === 'scene' && !cutView() && t >= cur.end - 0.02) {
          if (loopScene) seekTo(cur.start); else { v.pause(); seekTo(cur.end - 0.04); }
        } else if (mode === 'full') {
          const sc = sceneAt(t);
          if (pauseAtEnd && playingScene && sc && sc.id !== playingScene) { pauseAll(); seekTo(scene(playingScene).end - 0.04); playingScene = null; }
          else if (sc && sc.id !== sel) { sel = sc.id; elSel = null; renderInspector(); markRows(true); paintTop(); }
        }
      }
      if (mode === 'scene' && cur) {
        const vt = viewTime(), len = axNow().toView(cur.end) - cur.start, was = cur.end - cur.start;
        player.time.innerHTML = `<b>${c2(Math.max(0, vt - cur.start))}</b> / ${c2(len)}${Math.abs(len - was) > 0.004 ? ` <span class="sub">· was ${c2(was)}</span>` : ''} <span class="sub">· ${clock(t)} · frame ${Math.round(t * (D.fps || 30))}</span>`;
      }
      else player.time.innerHTML = `<b>${clock(t)}</b> / ${clock(dur())}`;
      const sc = sceneAt(t);
      player.now.textContent = mode === 'full' && sc ? `${sectionOf(sc.id)?.label ? `${sectionOf(sc.id).label} · ` : ''}${sc.n} ${sc.title}` : '';
      if (!editing) paintPins(player.pins, sc?.id, t);
      if (mode === 'full') player.tl.draw(); else player.stl.tick();
      if (mode === 'full') markNow(sc?.id);
      refreshKeysUI();
      if (edPlaying) $('#scPlay', el)?.classList.add('on');
    };
    raf = requestAnimationFrame(loop);
  }

  const tlh = { full: LS('studio.scenes.tlh.full') || 'max', scene: LS('studio.scenes.tlh.scene') || 'max' };
  const lastOpen = { full: null, scene: null };
  let miniH = 23;
  // One scene shows the cut as it is now. Its view keeps the scene's start where the sheet has it (web/cuttrim.js axis),
  // so only what follows an edit moves. A scene the waiting cut change reaches, or one with a cut being pulled, plays the
  // take through the new cut ("cut view": the finished look comes back with Claude's next render); the rest play the render.
  const axNow = () => trim.axis(mode === 'scene' ? scene(sel) : null);
  // Where the picture comes from: the render, or the take played through the cut as it is now ("cut view"), when
  //   'cut'     a cut change waiting reaches this scene, or a cut is being pulled (One scene);
  //   'none'    there is no render yet;
  //   'unbuilt' the render doesn't reach this scene (an intro render, and a body scene).
  // The take maps through tax(): One scene's own view (its start kept where the sheet has it), Whole video's whole cut.
  function takeWhy() {
    if (!player || editing || !trim.ready()) return null;
    if (mode === 'scene' && (trim.busy() || trim.touched(scene(sel)))) return 'cut';
    if (!renderFile) return 'none';
    // Whole video goes by the moment too: a render a few frames shorter than its scene (an intro render that ends
    // 33 ms before the intro block) hands over to the take where it ends, not at the next scene.
    if (mode === 'full' && reaches(scene(sel)) && player.t >= renderEnd() - 0.02 && (player.v.ended || player.v.paused)) return 'unbuilt';
    return reaches(scene(sel)) ? null : 'unbuilt';
  }
  const cutView = () => Boolean(takeWhy());
  const tax = () => (mode === 'scene' ? axNow() : trim.axis(D?.scenes?.[0] || null));
  const playTake = () => { if (!player) return; player.take.muted = false; player.take.play().catch(() => {}); };
  const TAKE_NOTE = { cut: 'The new cut · the take plays here until Claude re-renders this scene', none: 'No render yet · the take plays here, on the cut', unbuilt: 'Not built yet · the take plays here, on the cut' };
  const trimming = () => Boolean(player?.frame.classList.contains('trimming'));
  // Time on the sheet's timeline (notes, pins, keyframes and the render all use it).
  const playerTime = () => {
    if (!player) return 0;
    if (cutView()) return trimming() ? player.t : tax().toOld(viewTime());
    return editing || !renderFile ? player.t : player.v.currentTime;
  };
  // Time on the One scene timeline: the take's moment in cut view, else the sheet's time placed on the view.
  function viewTime() {
    if (!player) return 0;
    const ax = cutView() ? tax() : axNow();
    if (cutView() && ax.srcToView) return ax.srcToView(player.take.currentTime);
    return ax.toView(editing || !renderFile ? player.t : player.v.currentTime);
  }
  function seekView(t) {
    if (!player) return;
    const ax = cutView() ? tax() : axNow();
    if (cutView() && ax.viewToSrc) { seekTake(ax.viewToSrc(Math.max(0, t))); player.t = ax.toOld(t); return; }
    seekTo(ax.toOld(t));
  }
  function seekTake(x) { const tk = player.take; if (tk.readyState > 0) tk.currentTime = x; else tk.dataset.want = String(x); }
  // The take's file goes on the picture's take videos once Scenes knows it (GET /cut-take).
  function ensureTake() {
    const tk = trim.take();
    if (!player || !tk?.ok || player.take.dataset.f === tk.video) return;
    player.take.dataset.f = tk.video;
    player.take.src = media(tk.video);
    // (the trim lens's inset gets the take when a pull starts: every video on the page holds one of the browser's few
    // connections to Video Octopus while it loads, and the list's thumbnails need one too)
    delete player.take2.dataset.f;
    player.take.addEventListener('loadedmetadata', () => { const w = player?.take.dataset.want; if (w != null && w !== '') { player.take.currentTime = Number(w); delete player.take.dataset.want; } });
  }
  function ensureTake2() { const f = player?.take.dataset.f; if (f && player.take2.dataset.f !== f) { player.take2.dataset.f = f; player.take2.src = media(f); } }
  // Switch the picture between the render and the take (cut view), keeping the moment (keep = false: player.t was just
  // set, by a seek). A render playing into a scene it doesn't reach hands over to the take, which plays on.
  let viewWas = false, viewScene = null, viewWhy = null;
  function applyView(keep = true) {
    if (!player) return;
    const why = takeWhy(), on = Boolean(why);
    player.none.hidden = on || Boolean(renderFile) || editing;
    if (on && why !== viewWhy) player.cutNote.textContent = TAKE_NOTE[why];
    viewWhy = why;
    if (on === viewWas && (!on || viewScene === sel)) return;
    // Whole video maps the take through one axis for the whole cut: a new scene needs no new seek.
    if (on && viewWas && mode === 'full') { viewScene = sel; return; }
    let go = false;
    if (on) {
      if (!viewWas) { go = mode === 'full' && renderFile && !editing && (!player.v.paused || player.v.ended); if (keep && renderFile && !editing) player.t = player.v.currentTime; player.v.pause(); }
      const ax = tax();
      if (!trimming() && ax.viewToSrc) seekTake(ax.viewToSrc(ax.toView(player.t)));
      compare(null);
    } else { player.take.pause(); if (renderFile && !editing) player.v.currentTime = player.t; }
    viewWas = on; viewScene = sel;
    player.frame.classList.toggle('cutview', on);
    player.cutNote.hidden = !on;
    player.pins.style.visibility = on ? 'hidden' : '';
    if (go) playTake();
    player.play.classList.toggle('on', isPlaying());
    paintEls(true);
  }
  const isPlaying = () => Boolean(player && (editing ? edPlaying : cutView() ? !player.take.paused : !player.v.paused));
  function seekTo(t) {
    if (!player) return;
    player.t = Math.max(0, t);
    // Whole video: the scene there becomes the one shown (it decides render or take); then the picture switches with
    // the new moment (not the render's old one) and goes there.
    if (mode === 'full' && D?.scenes?.length && !editing) {
      const sc = sceneAt(player.t);
      if (sc && sc.id !== sel) { sel = sc.id; elSel = null; markRows(false); paintTop(); renderInspector(); }
    }
    if (!editing) applyView(false);
    if (cutView()) { const ax = tax(); if (ax.viewToSrc) seekTake(ax.viewToSrc(ax.toView(player.t))); return; }
    if (renderFile && !editing) player.v.currentTime = player.t;
    if (editing) { if (player.under.getAttribute('src')) player.under.currentTime = player.t; edClock = null; redraw(); }
  }
  function pauseAll() { if (editing) editPlay(false); else { player?.v.pause(); player?.take.pause(); } }
  // In Edit graphics the picture is the scene's own HTML over the source video: playing it draws the scene live, so
  // moves and keyframes play straight away (before any render).
  let edPlaying = false, edRaf = 0, edClock = null;
  function editPlay(on) {
    if (!player || on === edPlaying) return;
    const u = player.under, s = scene(sel), hasVideo = Boolean(u.getAttribute('src'));
    cancelAnimationFrame(edRaf);
    edPlaying = on;
    player.play.classList.toggle('on', on); player.play.setAttribute('aria-label', on ? 'Pause' : 'Play');
    if (!on) { if (hasVideo) { u.pause(); u.muted = true; player.t = u.currentTime; } redraw(); renderInspector(); return; }
    if (mode === 'scene' && s && (player.t < s.start || player.t >= s.end - 0.05)) seekTo(s.start);
    if (hasVideo) { u.currentTime = player.t; u.muted = false; u.play().catch(() => {}); }
    edClock = null;
    const step = (now) => {
      if (!edPlaying) return;
      if (hasVideo) player.t = u.currentTime;
      else { if (edClock != null) player.t += (now - edClock) / 1000; edClock = now; }
      const cur = scene(sel);
      if (mode === 'scene' && cur && player.t >= cur.end - 0.02) {
        if (loopScene) { player.t = cur.start; if (hasVideo) u.currentTime = cur.start; } else { editPlay(false); return; }
      }
      redraw();
      edRaf = requestAnimationFrame(step);
    };
    edRaf = requestAnimationFrame(step);
  }
  function togglePlay(forcePlay) {
    if (editing) return editPlay(forcePlay === true ? true : !edPlaying);
    if (cutView()) {
      // The take through the cut: One scene from the scene's start when it's outside it; Whole video from here (from
      // the scene's start at the very end).
      const tk = player.take, s = scene(sel);
      if (tk.paused || forcePlay === true) {
        if (mode === 'scene') { const ve = axNow().toView(s.end), vt = viewTime(); if (vt < s.start - 0.01 || vt >= ve - 0.1) seekView(s.start); }
        else { if (player.t >= D.scenes.at(-1).end - 0.1) seekTo(s.start); pin = null; playingScene = s.id; }
        playTake();
      } else tk.pause();
      return;
    }
    if (!renderFile || !player) return toast(player && !trim.ready() ? 'There is no render yet, and the take is still loading: try again in a moment.' : 'There is no render to play yet.');
    const v = player.v, s = scene(sel);
    if (v.paused || forcePlay === true) {
      if (mode === 'scene' && s && (v.currentTime < s.start || v.currentTime >= s.end - 0.1)) seekTo(s.start);
      v.play().catch(() => {});
    } else v.pause();
  }
  function setMode(m) {
    if (m === mode) return;
    trim.closeLens(); compare(null);
    mode = m; LS('studio.scenes.mode', m);
    if (editing) stopEditing();
    applyMode();
    renderInspector();
  }
  function applyMode() {
    if (!player) return;
    player.el.querySelectorAll('#s2Mode button').forEach((b) => { const on = b.dataset.m === mode; b.classList.toggle('on', on); b.setAttribute('aria-pressed', String(on)); });
    $('#scTl', player.el).hidden = mode !== 'full';
    $('#scStl', player.el).hidden = mode !== 'scene';
    $('#scLoop', player.el).checked = mode === 'scene' ? loopScene : pauseAtEnd;
    $('#scLoopL', player.el).textContent = mode === 'scene' ? 'Loop this scene' : 'Pause at the end of each scene';
    $('#scLoopW', player.el).title = $('#scLoopL', player.el).textContent;
    player.el.classList.toggle('one', mode === 'scene');
    renderList(); paintTop();
    requestAnimationFrame(() => fitTl());
    const s = scene(sel);
    if (mode === 'scene' && s) {
      const t = playerTime();
      if (t < s.start || t >= s.end) seekTo(s.start + Math.min((s.end - s.start) * 0.4, 2));
      player.stl.render();
      ensureSamples();
    } else if (s) player.tl.show(s.start, s.end);
    paintEls(true);
  }
  function step(k) {
    const i = D.scenes.findIndex((s) => s.id === sel), n = D.scenes[i + k];
    if (n) select(n.id);
  }

  async function loadPeaks() {
    const f = renderFile;
    peaksFor = f; peaks = null;
    try {
      const p = await api(`/api/projects/${enc}/peaks?f=${encodeURIComponent(f)}`);
      if (renderFile !== f) return;
      peaks = p.data?.length ? p : null;
      player?.tl.setData({ words: D.words, peaks: wholePeaks(), note: `${D.scenes.length} scenes · ${D.words.length} words` });
      player?.stl.render();
    } catch {}
  }
  // Whole video's Voice lane: the render's waveform as far as it reaches, the take's (through the cut) after it, or all
  // the take's before any render.
  function wholePeaks() {
    const end = D?.scenes?.at(-1)?.end || 0, rp = peaksFor === renderFile ? peaks : null;
    const tw = trim.ready() && end ? trim.wave(trim.axis(D.scenes[0]), 0, end + 1) : null;
    if (!tw) return rp;
    if (!rp) return tw;
    if (rp.rate !== tw.rate) return rp;
    const data = Array.from(tw.data), reach = Math.min(renderEnd(), end + 1);
    for (let k = 0; k < rp.data.length && k / rp.rate < reach; k++) data[k] = rp.data[k];
    return { rate: tw.rate, data };
  }

  // A picture per scene for the list, taken from the render (a hidden video seeks to each scene in turn).
  async function captureThumbs() {
    const f = renderFile, job = ++thumbJob;
    thumbsFor = f;
    const v = document.createElement('video');
    v.muted = true; v.preload = 'auto'; v.playsInline = true; v.src = renderUrl();
    try { await new Promise((res, rej) => { v.addEventListener('loadeddata', res, { once: true }); v.addEventListener('error', rej, { once: true }); }); } catch { return; }
    const c = document.createElement('canvas'); c.width = 192; c.height = Math.round(192 * (D.frame[1] / D.frame[0]));
    const g = c.getContext('2d');
    for (const s of D.scenes) {
      if (job !== thumbJob || renderFile !== f) break;
      if (thumbs.has(`${f}|${s.id}`) || !reaches(s)) continue; // a scene the render doesn't reach has no picture in it
      v.currentTime = Math.min(s.end - 0.05, s.start + Math.min((s.end - s.start) * 0.4, 2));
      await new Promise((res) => { v.addEventListener('seeked', res, { once: true }); setTimeout(res, 2500); });
      try { g.drawImage(v, 0, 0, c.width, c.height); thumbs.set(`${f}|${s.id}`, c.toDataURL('image/jpeg', 0.72)); } catch { break; }
      const img = player?.list.querySelector(`.s2-row[data-id="${CSS.escape(s.id)}"] img`);
      if (img && reaches(s)) { img.src = thumbs.get(`${f}|${s.id}`); img.hidden = false; }
    }
    v.removeAttribute('src'); v.load();
  }

  // ---------- the list: sections with their scenes ----------
  // The list folds to a numbered strip (remembered per view; One scene starts folded, as on the scene timeline board).
  const stripOn = () => Boolean(listFold[mode]);
  function setStrip(on) { listFold[mode] = on; LS(`studio.scenes.strip.${mode}`, on ? '1' : '0'); renderList(); requestAnimationFrame(() => fitTl()); }
  function renderStrip() {
    const groups = D.sections?.length ? D.sections : [{ id: '', label: '', scenes: D.scenes.map((x) => x.id) }];
    const dot = (t) => (t === 'ok' ? 'var(--ok)' : t === 'changed' || t === 'question' || t === 'waiting' ? 'var(--accent)' : t === 'notes' ? 'var(--sel)' : t === 'sent' ? 'var(--warn)' : 'var(--line-2)');
    player.lh.innerHTML = `<button class="s2-unfold" aria-label="Show the scene list" title="Show the scene list">»</button>`;
    $('.s2-unfold', player.lh).onclick = () => setStrip(false);
    player.list.replaceChildren(...groups.map((g, gi) => {
      const box = h(`<div class="s2-sg">${gi ? '<i class="s2-sgl" aria-hidden="true"></i>' : ''}${g.label ? `<span class="s2-sgn" title="${esc(g.label)}">${esc(g.label.split(/\s+/).pop().slice(0, 6).toUpperCase())}</span>` : ''}</div>`);
      for (const sid of g.scenes) {
        const sc = scene(sid);
        if (!sc) continue;
        const b = h(`<button class="s2-chip${sc.id === sel ? ' on' : ''}" data-id="${esc(sc.id)}" aria-label="Scene ${sc.n}: ${esc(sc.title)}" title="${sc.n} · ${esc(sc.title)} · ${esc(toneText(sc) || 'To review')}" aria-current="${sc.id === sel}">${sc.n}<i style="background:${dot(toneOf(sc))}"></i></button>`);
        b.onclick = () => select(sc.id);
        box.append(b);
      }
      return box;
    }));
  }
  function renderList() {
    if (!player) return;
    player.el.classList.toggle('strip', stripOn());
    if (stripOn()) return renderStrip();
    const tones = D.scenes.map(toneOf);
    const appr = tones.filter((t) => t === 'ok').length, chg = tones.filter((t) => t === 'changed' || t === 'question').length, nb = tones.filter((t) => t === 'unbuilt').length, ni = tones.filter((t) => t === 'notin').length;
    const rest = Math.max(0, D.scenes.length - appr - chg - nb - ni);
    player.lh.innerHTML = `<div class="s2-lt"><b>${D.scenes.length} scenes</b><span class="sub">${D.sections?.length > 1 ? `${D.sections.length} sections · ` : ''}${clock(D.scenes.at(-1).end)}</span></div>
      <div class="s2-prog" title="${appr} approved · ${chg} to rewatch · ${rest} to review${ni ? ` · ${ni} not in this build` : ''}${nb ? ` · ${nb} not built yet` : ''}"><i class="ok" style="flex:${appr}"></i><i class="chg" style="flex:${chg}"></i><i style="flex:${rest}"></i>${ni + nb ? `<i class="nb" style="flex:${ni + nb}"></i>` : ''}</div>
      <div class="s2-legend sub"><span><i class="ok"></i>${appr} approved</span><span><i class="chg"></i>${chg} to rewatch</span><span><i></i>${rest} to review</span>${ni ? `<span><i class="nb"></i>${ni} not in this build</span>` : ''}${nb ? `<span><i class="nb"></i>${nb} not built yet</span>` : ''}</div>
      <button class="s2-foldlist" aria-label="Fold the list to a strip" title="Fold the list to a strip of scene numbers">«</button>`;
    $('.s2-foldlist', player.lh).onclick = () => setStrip(true);
    const groups = D.sections?.length ? D.sections : [{ id: '', label: 'All scenes', start: D.scenes[0].start, end: D.scenes.at(-1).end, scenes: D.scenes.map((s) => s.id) }];
    player.list.replaceChildren(...groups.map((g) => {
      const fold = folded.has(g.id);
      const box = h(`<div class="s2-group${fold ? ' folded' : ''}">
        <div class="s2-gh"><button class="s2-fold" aria-expanded="${!fold}" aria-label="${fold ? 'Show' : 'Hide'} ${esc(g.label)}">${ICON.caret}</button>
          <b class="s2-gl" title="${g.block ? 'Double-click to rename this block' : 'From the production sheet'}">${esc(g.label)}</b><span class="mono sub">${clock(g.start)} – ${clock(g.end)}</span><span class="gap"></span><span class="sub">${g.scenes.length}</span></div>
        <div class="s2-rows"></div></div>`);
      $('.s2-fold', box).onclick = () => { fold ? folded.delete(g.id) : folded.add(g.id); LS(`studio.scenes.folded.${id}`, JSON.stringify([...folded])); renderList(); };
      $('.s2-gl', box).ondblclick = () => renameSection(g, $('.s2-gl', box));
      const rows = $('.s2-rows', box);
      if (!fold) for (const sid of g.scenes) {
        const s = scene(sid);
        if (!s) continue;
        // An unbuilt or not-in-this-build scene says so once, on a quiet picture (A14: not again in the line under the
        // title; B5a: no black frame where the picked render has no picture of it).
        const tone = toneOf(s), th = thumbs.get(`${renderFile}|${s.id}`);
        const row = sceneRow({ tone, text: toneText(s, tone), built: builtSc(s), inRender: inRender(s) });
        const b = h(`<button class="s2-row${s.id === sel ? ' on' : ''}" role="listitem" data-id="${esc(s.id)}" aria-current="${s.id === sel}">
          <span class="s2-th${row.quiet ? ' nb' : ''}"><img alt=""${th && !row.quiet ? ` src="${th}"` : ' hidden'}>${row.picture ? `<span class="s2-nbl">${esc(row.picture)}</span>` : ''}<span class="s2-n">${s.n}</span></span>
          <span class="s2-rt"><b>${esc(s.title)}</b>${s.line ? `<span class="s2-line" title="${esc(s.line)}">“${esc(s.line)}”</span>` : ''}<span class="sub"><span class="mono">${clock(s.start)}</span>${row.line == null ? '' : `<i style="background:${TONE_DOT[tone]}"></i>${esc(row.line)}`}</span></span>
          <span class="s2-now" hidden>▶ NOW</span></button>`);
        b.onclick = () => select(s.id);
        rows.append(b);
      }
      return box;
    }));
  }
  function markRows(scroll) {
    if (!player) return;
    player.list.querySelectorAll('.s2-row, .s2-chip').forEach((r) => { const on = r.dataset.id === sel; r.classList.toggle('on', on); r.setAttribute('aria-current', String(on)); });
    if (scroll) player.list.querySelector('.s2-row.on, .s2-chip.on')?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }
  let nowId = null;
  function markNow(sid) {
    const playing = isPlaying();
    const want = playing ? sid : null;
    if (want === nowId) return;
    nowId = want;
    player.list.querySelectorAll('.s2-now').forEach((x) => (x.hidden = x.closest('.s2-row')?.dataset.id !== want));
  }
  async function renameSection(g, label) {
    if (!g.block) return toast('This section comes from the production sheet. Add the video\'s blocks (the Blocks strip on the canvas) to rename sections here.');
    const input = h(`<input class="field s2-rename" value="${esc(g.label)}" aria-label="Section name">`);
    label.replaceWith(input);
    input.focus(); input.select();
    const done = async (save) => {
      const name = input.value.trim();
      if (save && name && name !== g.label) {
        try { await api(`/api/projects/${enc}/blocks`, { op: 'update', id: g.block, label: name }); await update(); return; } catch (e) { toast(e.message); }
      }
      renderList();
    };
    input.onkeydown = (e) => { if (e.key === 'Enter') done(true); if (e.key === 'Escape') done(false); };
    input.onblur = () => done(true);
  }
  function paintTop() {
    if (!player) return;
    const s = scene(sel), tone = toneOf(s), g = sectionOf(s.id);
    // One scene: how long it is, its layout, and when Claude last changed it (its notes Claude finished, and the render that has them).
    let meta = '';
    if (mode === 'scene') {
      const len = axNow().toView(s.end) - s.start, lay = openChange(s.id, 'layout')?.to || s.layout;
      const fin = notesOf(s.id).filter((n) => ['done', 'question'].includes(n.status) && n.sent_at);
      const r = fin.length ? [...D.renders].reverse().find((x) => x.at > Math.max(...fin.map((n) => Date.parse(n.sent_at) || 0))) : null;
      meta = `<span class="sub s2-meta"><span class="mono">${len.toFixed(1)} s</span>${lay ? ` · ${esc(LAYOUT_NAME[lay] || lay)}` : ''}${r ? ` · Changed by Claude ${esc(ago(r.at))}` : ''}</span>`;
    }
    player.title.innerHTML = `<b>${s.n} · ${esc(s.title)}</b>${g ? `<span class="sub">${esc(g.label)}</span>` : ''}<span class="sc-st ${tone}">${esc(toneText(s, tone))}</span>${meta}`;
    paintCmp();
    const n = packageCount();
    $('#s2PkgN', player.el).textContent = n || '';
    $('#s2Pkg', player.el).classList.toggle('has', n > 0);
  }

  // ---------- the scene's graphics on the timeline: when each kit element is on screen ----------
  // The scene's HTML is drawn at many moments of the scene (through the kit, in a hidden frame) and each element's
  // first and last appearance becomes its clip. Elements that declare { in, out } in Octopus.el use those times.
  function clipsFor(sid) {
    const s = scene(sid);
    if (!s) return { state: 'none', list: [] };
    if (!D.sceneFile) return { state: 'none', list: [] };
    if (!D.kit?.has) return { state: 'nokit', list: [] };
    if (samples.key !== sampleKey(sid)) return { state: 'loading', list: [] };
    if (samples.state !== 'ready') return { state: samples.state, list: [] };
    const moved = new Set(Object.entries(D.overrides?.scenes || {}).filter(([k]) => k === sid || k === '*').flatMap(([, els]) => Object.keys(els)));
    return { state: 'ready', old: kitOld(), list: samples.clips.map((c) => ({ ...c, on: c.id === elSel, moved: moved.has(c.id), keys: keysOf(sid, c.id),
      runs: c.runs.map((r, k) => { const w = openChange(sid, 'timing', runTarget(c, k).id); return { ...r, waiting: w?.to?.in != null ? { in: w.to.in, out: w.to.out } : null }; }) })) };
  }
  // An element that shows several times has a clip each time; its timing changes name which one (id~2 = the second).
  const runTarget = (c, k) => ({ id: k ? `${c.id}~${k + 1}` : c.id, label: c.runs?.length > 1 ? `${c.label} (${k + 1} of ${c.runs.length})` : c.label });
  // The clips on the view: moved by the cut change where it reaches them, with where they were (a ghost) when they moved.
  function clipsView(sid) {
    const cl = clipsFor(sid);
    if (cl.state !== 'ready') return cl;
    const ax = axNow(), mv = (t) => ax.toView(t), off = (a, b) => Math.abs(a - b) > 0.004;
    return { ...cl, list: cl.list.map((c) => {
      const runs = c.runs.map((r) => { const a = mv(r.in), b = mv(r.out); return { in: a, out: b, ghost: off(a, r.in) || off(b, r.out) ? { in: r.in, out: r.out } : null, waiting: r.waiting ? { in: mv(r.waiting.in), out: mv(r.waiting.out) } : null }; });
      return { ...c, in: runs[0].in, out: runs[runs.length - 1].out, runs, keys: c.keys.map((k) => ({ ...k, t0: k.t, t: mv(k.t) })), marks: (c.marks || []).map((m) => ({ ...m, t: mv(m.t) })) };
    }) };
  }
  function sceneView() { const s = scene(sel); if (!s) return null; const ax = axNow(); return ax.id ? s : { ...s, end: ax.toView(s.end), was: { start: s.start, end: s.end } }; }
  // The take's waveform on the view, for the scene and a little either side.
  function waveView() { const s = scene(sel); if (!s) return null; const ax = axNow(), e = ax.toView(s.end), m = 2 + (e - s.start) * 0.1; return trim.wave(ax, Math.max(0, s.start - m), e + m); }
  // What the scene timeline draws for the cut: the pull (its label, where it started, B's red / blue) and the moved end.
  function trimMarks() {
    const s = scene(sel), ax = axNow(), out = {};
    if (!s || ax.id) return out;
    const p = trim.pulling();
    if (p) {
      const j = ax.joins.find((x) => x.i === p.i);
      out.seam = { t: j ? j.t : p.t0, t0: p.t0, delta: p.delta, word: p.word, side: p.side };
      if (p.pend && ax.srcToView && getP()?.editing?.trimHighlight) out.pend = { a: ax.srcToView(p.pend.a), b: ax.srcToView(p.pend.b), kind: p.pend.kind };
    }
    const e = ax.toView(s.end);
    if (Math.abs(e - s.end) > 0.004) out.end = { t: e, was: s.end, d: e - s.end };
    return out;
  }
  // The camera lane: where the camera is for the scene's layout (a layout change waiting shows dashed).
  function cameraOf(s) {
    if (!s) return [];
    const w = openChange(s.id, 'layout'), lay = w?.to || s.layout, a = s.start, b = axNow().toView(s.end);
    const label = CAMERA_OF[lay] || (lay ? `Camera · ${lay}` : 'Camera · layout not set in the sheet');
    const zoom = s.skills.includes('talking-head-zoom') && /talking-head|cutout/.test(lay || '') ? ' · push-ins (talking-head-zoom)' : '';
    return [{ a, b, label: `${label}${zoom}${w ? ' · layout change waiting' : ''}`, none: /^No camera/.test(label), waiting: Boolean(w) }];
  }
  function neighbours() { const i = D.scenes.findIndex((x) => x.id === sel); return { prev: D.scenes[i - 1]?.n ?? null, next: D.scenes[i + 1]?.n ?? null }; }
  // Whole video: while the lens is open, the scenes after the cut move with it.
  function lensShift() {
    const L = trim.lensAt();
    if (L?.kind !== 'whole' || !D.cutScenes) return (t) => t;
    return cutMapper(D.cutScenes, trim.segs());
  }
  // The cuts Whole video can open the lens on: the joins of the sheet's cut, and the edits waiting, with where each
  // sits on the cut now (the lens works on the cut now).
  function wholeCuts() {
    const A = D?.cutScenes, B = trim.segs();
    if (!A?.length || !B.length) return [];
    const m = cutMapper(A, B);
    return [...cutJoins().map((t) => ({ t, tNew: m(t) })), ...(D.cutWaiting || []).map((w) => ({ t: w.t, tNew: w.tNew }))];
  }
  // Where the lens sits: above the timeline it opened from, its arrow at the cut.
  function lensSpot(kind, t) {
    if (!player) return null;
    const main = $('.s2-main', player.el), host = kind === 'whole' ? $('#scTl', player.el) : $('#scStl', player.el), cv = host?.querySelector('.tk-canvas');
    if (!main || !cv) return null;
    const mr = main.getBoundingClientRect(), hr = host.getBoundingClientRect(), cr = cv.getBoundingClientRect();
    const track = kind === 'whole' ? player.tl.track : player.stl.track;
    return { parent: main, bottom: Math.max(8, mr.bottom - hr.top + 8), x: cr.left - mr.left + track.xOf(t) };
  }
  // Compare with the previous render (C, or the transport's button): the same moment of the version before.
  const prevRender = () => (renderFile && D?.renders ? previousOf(D.renders, renderFile) : null);
  function compare(m) {
    if (!player || !cmp) return;
    const pr = prevRender();
    if (m && !pr) { toast('There is no earlier render to compare with.'); return; }
    if (m && cutView()) { toast(takeWhy() === 'cut' ? 'This scene plays the new cut from the take: compare works on the renders.' : 'This scene isn\'t in the render yet: compare works on the renders.'); return; }
    cmp.set(m, pr ? `${media(pr.file)}&v=${Math.round(pr.at)}` : null, [versionName(pr?.file), versionName(renderFile)]);
    paintCmp();
  }
  function paintCmp() {
    const b = player && $('#scCmp', player.el), pr = prevRender();
    if (!b) return;
    b.hidden = !pr;
    if (pr) {
      const v = esc(versionName(pr.file)), on = Boolean(cmp?.mode());
      b.innerHTML = `<span class="lbl">${on ? `Comparing with ${v} · C` : `Compare with ${v}`}</span><span class="lbl-s">vs ${v}</span>`;
      b.setAttribute('aria-label', on ? `Comparing with ${versionName(pr.file)}` : `Compare with ${versionName(pr.file)}`);
      b.classList.toggle('on', on);
    }
  }
  // Keyframes and markers need kit 2; kit 3 adds rows nested under their parent and the type bar on text (optional).
  const kitOld = () => Boolean(D.kit?.has && (D.kit.version || 1) < 2);
  const kitBehind = () => Boolean(D.kit?.has && (D.kit.version || 1) < (D.kit.latest || 1));
  const hiddenEls = () => (player?.stl ? samples.clips.map((c) => c.id).filter((x) => player.stl.track.flags(`el:${x}`).hide) : []);
  // Moves don't change when an element is on screen, so they stay out of the key: the outlines follow them instead.
  const sampleKey = (sid) => `${sid}|${D.sceneFile}|${renderAt()}`;
  // A sampled box moved to where the element is now: its keys at that moment, or its fixed move.
  function shifted(k, t) {
    const a = k.ov || {}, o = valueAt(sel, k.id, t), f = (o.s || 1) / (a.scale || 1);
    const cx = k.x + k.w / 2 - (a.dx || 0) + (o.dx || 0), cy = k.y + k.h / 2 - (a.dy || 0) + (o.dy || 0), w = k.w * f, hh = k.h * f;
    return { ...k, x: cx - w / 2, y: cy - hh / 2, w, h: hh };
  }
  async function ensureSamples() {
    const s = scene(sel);
    if (!s || !D.kit?.has || !D.sceneFile) return;
    const key = sampleKey(s.id);
    if (samples.key === key) return;
    const job = ++sampleJob;
    samples = { key, state: 'loading', times: [], hits: [], clips: [] };
    player?.stl.render();
    if (!probe) {
      const host = h(`<div class="sf-probe" aria-hidden="true"></div>`);
      document.body.append(host);
      probe = new SceneFrames(host, { src: sceneSrc(), layers: D.kit.layers, frame: D.frame });
    }
    // Kit 2 measures what each element paints (its box as drawn and its opacity), without the creator's keys, so the
    // samples show Claude's own motion: the clips' in/out and the ◇ markers come from them.
    const len = s.end - s.start, dt = Math.max(1 / 30, len / 240);
    const times = [], hits = [];
    for (let t = s.start + 0.02; t < s.end; t += dt) {
      const res = await probe.draw(t, D.overrides, { measure: true, noKeys: true });
      if (job !== sampleJob) return;
      times.push(t);
      hits.push(res.flatMap((r) => (r.hits || []).map((k) => ({ ...k, layer: r.layer }))));
    }
    // Each element's runs on screen (gone for more than a quarter second starts a new one), the element it's drawn
    // inside (kit 3) and whether it draws text.
    const by = new Map(), gap = Math.max(0.25, dt * 2.5);
    times.forEach((t, i) => {
      for (const k of hits[i]) {
        let c = by.get(k.id);
        if (!c) { c = { id: k.id, label: k.label, runs: [], declared: null, parent: k.parent || null, text: false, last: -1e9 }; by.set(k.id, c); }
        if (t - c.last > gap) c.runs.push({ in: t, out: t }); else c.runs[c.runs.length - 1].out = t;
        c.last = t;
        if (k.text) c.text = true;
        if (!c.parent && k.parent) c.parent = k.parent;
        if (Number.isFinite(k.in) && Number.isFinite(k.out)) c.declared = [k.in, k.out];
      }
    });
    const clips = [...by.values()].map((c) => {
      let runs = c.declared ? [{ in: c.declared[0], out: c.declared[1] }] : c.runs.map((r) => ({ in: Math.max(s.start, r.in - dt / 2), out: Math.min(s.end, r.out + dt / 2) }));
      if (runs.length > 1) runs = runs.filter((r) => r.out - r.in > dt * 1.6);
      if (!runs.length) runs = [{ in: Math.max(s.start, c.runs[0].in - dt / 2), out: Math.min(s.end, c.runs[c.runs.length - 1].out + dt / 2) }];
      return { id: c.id, label: c.label, in: runs[0].in, out: runs[runs.length - 1].out, runs, parent: c.parent, text: c.text || TEXTY.test(`${c.id} ${c.label}`),
        marks: motionMarks(times.map((t, i) => { const k = hits[i].find((x) => x.id === c.id && x.m); return k ? { t, x: k.m.x, y: k.m.y, w: k.m.w, h: k.m.h, o: k.o } : null; }).filter(Boolean), dt) };
    });
    // Children right under their parent, indented (depth), each level in the order they first show.
    const ids = new Map(clips.map((c) => [c.id, c])), ordered = [];
    for (const c of clips) if (!ids.has(c.parent) || c.parent === c.id) c.parent = null;
    const walk = (c, d) => { if (ordered.includes(c)) return; c.depth = d; c.parentLabel = c.parent ? ids.get(c.parent)?.label : null; ordered.push(c); clips.filter((x) => x.parent === c.id).sort((a, b) => a.in - b.in).forEach((x) => walk(x, Math.min(d + 1, 6))); };
    clips.filter((c) => !c.parent).sort((a, b) => a.in - b.in).forEach((c) => walk(c, 0));
    for (const c of clips) walk(c, 0);
    clips.splice(0, clips.length, ...ordered);
    samples = { key, state: 'ready', times, hits, clips, dt };
    player?.stl.render();
    paintEls(true);
    if (elSel) renderInspector();
  }
  // The element outlines on the picture (One scene, paused): the kit's boxes at the nearest sampled moment.
  function paintEls(force) {
    if (!player) return;
    const box = player.els;
    const on = mode === 'scene' && !editing && !cutView() && samples.state === 'ready' && samples.key === sampleKey(sel) && player.v.paused;
    if (!on) { if (box.childElementCount) box.replaceChildren(); box.dataset.sig = ''; return; }
    const t = playerTime(), hide = new Set(hiddenEls());
    let i = 0, best = Infinity;
    samples.times.forEach((x, k) => { const d = Math.abs(x - t); if (d < best) { best = d; i = k; } });
    const list = (best <= (samples.dt || 0.2) * 1.5 ? samples.hits[i] || [] : []).filter((k) => !hide.has(k.id)).map((k) => shifted(k, t));
    const sig = `${i}|${elSel}|${hoverEl}|${list.map((k) => `${k.x | 0},${k.y | 0},${k.w | 0}`).join(';')}|${JSON.stringify(openChange(sel, 'style', elSel)?.to || null)}`;
    if (!force && box.dataset.sig === sig) return;
    if (box.contains(document.activeElement) && document.activeElement.closest('.sc-typebar')) return; // don't pull the type bar from under the pointer
    box.dataset.sig = sig;
    const [W, H] = D.frame;
    box.replaceChildren(...list.map((k) => {
      const b = h(`<button class="sc-el${k.id === elSel ? ' on' : ''}${k.id === hoverEl ? ' hover' : ''}" style="left:${(k.x / W) * 100}%;top:${(k.y / H) * 100}%;width:${(k.w / W) * 100}%;height:${(k.h / H) * 100}%" aria-label="Pick ${esc(k.label)}"><span>${esc(k.label)}</span></button>`);
      b.addEventListener('click', (e) => { e.stopPropagation(); pickElement(k.id); });
      return b;
    }));
    const k = list.find((x) => x.id === elSel), c = samples.clips.find((x) => x.id === elSel);
    if (k && c?.text) box.append(typeBar(k, c));
  }
  // The floating type bar under a picked text element: font, size, colour, bold,
  // italic, alignment and its words. Each change goes in the package for Claude, like the element panel's Type.
  const ALIGN = { left: 'M2 3h10M2 6h6M2 9h10M2 12h6', center: 'M2 3h10M4 6h6M2 9h10M4 12h6', right: 'M2 3h10M6 6h6M2 9h10M6 12h6' };
  function styleTo(c, patch, on = 'picture') {
    const next = { ...(openChange(sel, 'style', c.id)?.to || {}), ...patch };
    for (const key of Object.keys(next)) if (next[key] === '' || next[key] == null) delete next[key];
    return change('style', null, Object.keys(next).length ? next : null, { target: { id: c.id, label: c.label }, on });
  }
  function typeBar(k, c) {
    const [W, H] = D.frame, st = openChange(sel, 'style', c.id)?.to || {}, below = (k.y + k.h) / H < 0.8, bold = ['700', '900'].includes(String(st.weight));
    const bar = h(`<div class="sc-typebar ${below ? 'below' : 'above'}" role="toolbar" aria-label="Type of ${esc(c.label)}" style="left:${((k.x + k.w / 2) / W) * 100}%;top:${((below ? k.y + k.h : k.y) / H) * 100}%">
      <label class="vh" for="tbF">Font</label><select id="tbF" class="tb-f">${['', ...FONTS].map((f) => `<option value="${esc(f)}"${(st.font || '') === f ? ' selected' : ''}>${f ? esc(f) : 'Font as made'}</option>`).join('')}</select>
      <label class="vh" for="tbZ">Size in pixels</label><input id="tbZ" class="tb-z mono" type="number" min="8" max="400" placeholder="size" value="${esc(st.size ?? '')}">
      <span class="tb-sw" role="group" aria-label="Colour">${STYLE_COLORS.map(([hex, n]) => `<button data-c="${hex}" class="${st.color === hex ? 'on' : ''}" style="--c:${hex}" aria-label="${n}" aria-pressed="${st.color === hex}" title="${n}"></button>`).join('')}</span>
      <i class="tb-sep" aria-hidden="true"></i>
      <button data-b="bold" class="${bold ? 'on' : ''}" aria-pressed="${bold}" aria-label="Bold" title="Bold"><b>B</b></button>
      <button data-b="italic" class="${st.italic ? 'on' : ''}" aria-pressed="${Boolean(st.italic)}" aria-label="Italic" title="Italic"><i>I</i></button>
      <i class="tb-sep" aria-hidden="true"></i>
      ${Object.entries(ALIGN).map(([a, d]) => `<button data-al="${a}" class="${st.align === a ? 'on' : ''}" aria-pressed="${st.align === a}" aria-label="Align ${a}" title="Align ${a}"><svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true"><path d="${d}"/></svg></button>`).join('')}
      <i class="tb-sep" aria-hidden="true"></i>
      <button data-a="words" title="Change the words (in its panel)">Aa</button></div>`);
    for (const ev of ['click', 'pointerdown']) bar.addEventListener(ev, (e) => e.stopPropagation());
    bar.querySelector('.tb-f').onchange = (e) => styleTo(c, { font: e.target.value || null });
    bar.querySelector('.tb-z').onchange = (e) => styleTo(c, { size: e.target.value ? Math.round(Number(e.target.value)) : null });
    bar.querySelectorAll('[data-c]').forEach((b) => (b.onclick = () => styleTo(c, { color: st.color === b.dataset.c ? null : b.dataset.c })));
    bar.querySelector('[data-b=bold]').onclick = () => styleTo(c, { weight: bold ? null : '700' });
    bar.querySelector('[data-b=italic]').onclick = () => styleTo(c, { italic: st.italic ? null : 'yes' });
    bar.querySelectorAll('[data-al]').forEach((b) => (b.onclick = () => styleTo(c, { align: st.align === b.dataset.al ? null : b.dataset.al })));
    bar.querySelector('[data-a=words]').onclick = () => { pickElement(c.id, true); setTimeout(() => $('#elT', inspector)?.focus(), 0); };
    return bar;
  }
  function pickElement(eid, keep) {
    elSel = elSel === eid && tab === 'element' && !keep ? null : eid;
    tab = elSel ? 'element' : 'look';
    player?.stl.render();
    paintEls(true);
    renderInspector();
  }
  const beatsOf = (s) => (s?.beats || []).map(([a, b]) => ({ t: mmss(a), label: b })).filter((x) => x.t != null && x.t >= s.start - 0.5 && x.t <= s.end + 0.5);
  function sfxOf(s) {
    if (!s) return [];
    const out = s.sfx.map((label, i) => ({ t: s.sfxAt[i] ?? null, label, db: s.sfxDb?.[i] ?? null, waiting: Boolean(D.notes.find((n) => n.kind === 'change' && n.status === 'open' && n.scene === s.id && n.field === 'sfx' && n.to?.remove === label)) }));
    for (const n of D.notes) if (n.kind === 'change' && n.status === 'open' && n.scene === s.id && n.field === 'sfx' && n.to?.add) out.push({ t: n.to.t ?? null, label: n.to.add, file: n.to.file, added: true, waiting: true });
    return out;
  }
  // A sheet's effect is a name ("whoosh", "Soft thud ×5"): play it from the library sound with the same name.
  const squash = (x) => String(x || '').toLowerCase().replace(/×\s*\d+/g, '').replace(/[^a-z0-9]+/g, '');
  function soundFile(label) {
    const k = squash(label), list = D.options?.sounds || [];
    return (list.find((x) => squash(x.name) === k) || list.find((x) => k && (squash(x.name).includes(k) || k.includes(squash(x.name)))))?.file || null;
  }
  const dbText = (d) => (d == null ? 'As set' : `${d > 0 ? '+' : d < 0 ? '−' : ''}${Math.abs(d)} dB`);

  // ---------- changes into the package ----------
  async function change(field, from, to, extra = {}, sid = sel) {
    try {
      took(await api(`/api/projects/${enc}/notes`, { op: 'add', kind: 'change', scene: sid, field, from, to, render: renderFile, ...extra }));
      paint();
    } catch (e) { toast(e.message); }
  }
  // Timing dragged on the scene timeline: a change in the package, undoable (back to what was waiting before, or to
  // where it started, which drops the item).
  // The timeline works on the view (the cut as it is now): times go back onto the sheet's timeline here.
  function edgeChange(e) {
    const sid = sel, s = scene(sid), ax = axNow(), old = (t) => Math.round(ax.toOld(t) * 100) / 100, r2 = (t) => Math.round(t * 100) / 100;
    let target = null, from = e.from, to;
    if (e.kind === 'clip') {
      const c = samples.clips.find((x) => x.id === e.id) || { id: e.id, label: e.label, runs: [{ in: e.from.in, out: e.from.out }] }, run = c.runs[e.run || 0] || c.runs[0];
      target = runTarget(c, e.run || 0);
      from = { in: r2(run.in), out: r2(run.out) };
      to = { in: old(e.to.in), out: old(e.to.out) };
    } else { from = { start: r2(s.start), end: r2(s.end) }; to = { start: old(e.to.start), end: old(e.to.end) }; }
    const was = openChange(sid, 'timing', target?.id || null)?.to ?? from;
    const go = (v) => change('timing', from, v, { ...(target ? { target } : {}), on: 'timeline' }, sid);
    go(to);
    history?.push({ label: target ? `Retime ${target.label}` : 'Move the scene’s edges', undo: () => go(was), redo: () => go(to) });
  }
  async function askKit() {
    try { await api(`/api/projects/${enc}/kit`, {}); toast('Asked Claude to put this scene\'s graphics on the timeline (make them movable). Follow along in the chat.'); }
    catch (e) { toast(e.message); }
  }

  // ---------- pins on the picture ----------
  // A note with a spot shows as a numbered pin on its scene's picture; nearby in time it's solid.
  function paintPins(box, sid, t) {
    if (!box) return;
    const list = D.notes.filter((n) => n.pos && n.scene === sid && n.status !== 'resolved' && n.kind !== 'change');
    const want = list.map((n) => `${n.id}:${n.status}:${Math.abs((n.t ?? t) - t) < 1.2 ? 1 : 0}:${n.id === noteSel ? 1 : 0}`).join() + (pin && pin.scene === sid ? `|p${pin.pos.x},${pin.pos.y}` : '');
    if (box.dataset.sig === want) return;
    box.dataset.sig = want;
    box.replaceChildren(...list.map((n) => {
      const near = Math.abs((n.t ?? t) - t) < 1.2;
      const b = h(`<button class="pin ${esc(n.status)}${near ? '' : ' far'}${n.id === noteSel ? ' on' : ''}" style="left:${n.pos.x * 100}%;top:${n.pos.y * 100}%" title="${esc(n.text)}" aria-label="Note ${numberOf(n)}: ${esc(n.text)}">${numberOf(n)}</button>`);
      b.onclick = (e) => { e.stopPropagation(); noteSel = n.id; select(n.scene); if (n.t != null) seekTo(n.t); setTab('notes'); };
      return b;
    }), ...(pin && pin.scene === sid ? [h(`<span class="pin new" style="left:${pin.pos.x * 100}%;top:${pin.pos.y * 100}%" aria-hidden="true">+</span>`)] : []));
  }

  // Click the paused picture: that spot and moment get the next note. A click while it plays pauses it.
  function pickOnPicture(e) {
    if (e.target.closest('.pin, button')) return;
    if (isPlaying()) { pauseAll(); return; }
    const b = player.frame.getBoundingClientRect();
    const pos = { x: Math.min(1, Math.max(0, (e.clientX - b.left) / b.width)), y: Math.min(1, Math.max(0, (e.clientY - b.top) / b.height)) };
    const t = playerTime();
    const s = sceneAt(t);
    pin = { t, pos, scene: s.id, el: null };
    elSel = null;
    select(s.id, false);
    setTab('notes');
    focusComposer();
    findElement(pin);
  }
  // The scene element under a pin, from the scene's own HTML (only when the scene uses the scene kit).
  async function findElement(p) {
    if (!D.kit?.has || !D.sceneFile) return;
    if (!probe) {
      const host = h(`<div class="sf-probe" aria-hidden="true"></div>`);
      document.body.append(host);
      probe = new SceneFrames(host, { src: sceneSrc(), layers: D.kit.layers, frame: D.frame });
    }
    const res = await probe.draw(p.t, D.overrides);
    const [W, H] = D.frame, x = p.pos.x * W, y = p.pos.y * H;
    const hit = res.flatMap((r) => r.hits || []).reverse().find((k) => x >= k.x && x <= k.x + k.w && y >= k.y && y <= k.y + k.h);
    if (hit && pin === p) { p.el = { id: hit.id, label: hit.label }; renderInspector(); }
  }
  let kitBust = 0;
  const sceneSrc = () => `/api/projects/${enc}/files/${D.sceneFile.split('/').map(encodeURIComponent).join('/')}?studio=edit${kitBust ? `&k=${kitBust}` : ''}`;

  // ---------- selection, statuses ----------
  function select(sid, scroll = true) {
    if (!sid || sid === sel) { renderInspector(); return; }
    const t0 = player ? playerTime() : 0; // the moment on screen now (the picture can switch between render and take with sel)
    sel = sid; replyTo = null; elSel = null;
    if (tab === 'element') tab = 'look';
    if (pin && pin.scene !== sid) pin = null;
    markRows(scroll);
    paintTop();
    if (player) {
      const s = scene(sid);
      const inside = t0 >= s.start && t0 < s.end;
      if (mode === 'full') { player.tl.show(s.start, s.end); if (!isPlaying() && !editing && !inside) seekTo(s.start + Math.min((s.end - s.start) * 0.4, 2)); }
      else { if (!inside) { const was = isPlaying(); seekTo(s.start + (was ? 0 : Math.min((s.end - s.start) * 0.4, 2))); } player.stl.render(); ensureSamples(); }
    }
    if (editing) stopEditing();
    paintEls(true);
    renderInspector();
  }
  function setTab(t) { tab = t; if (t !== 'element') elSel = null; player?.stl.render(); paintEls(true); renderInspector(); }
  // Everything that changes with the notes: list, title, timelines, pins, the inspector.
  function paint() {
    if (!D?.ready || !player) return;
    renderList();
    paintTop();
    paintEls(true);
    player.pins.dataset.sig = '';
    if (mode === 'scene') player.stl.render();
    renderInspector();
  }

  // ---------- the inspector: Notes · Look · Package (or an element, or the graphics editor) ----------
  function tabsHtml() {
    const n = packageCount(), k = realNotes(sel).filter((x) => x.status !== 'resolved').length;
    return `<div class="s2-tabs seg wide" role="tablist" aria-label="Panel">
      ${planStep() ? `<button role="tab" data-t="plan" aria-selected="${tab === 'plan'}"${tab === 'plan' ? ' class="on"' : ''}>Plan${planWaiting() ? ' <span class="s2-badge n" aria-label="waiting for your approval">!</span>' : ''}</button>` : ''}
      <button role="tab" data-t="notes" aria-selected="${tab === 'notes'}"${tab === 'notes' ? ' class="on"' : ''}>Notes${k ? ` <span class="s2-badge n">${k}</span>` : ''}</button>
      <button role="tab" data-t="look" aria-selected="${tab === 'look' || tab === 'element'}"${tab === 'look' || tab === 'element' ? ' class="on"' : ''}>Look</button>
      <button role="tab" data-t="package" aria-selected="${tab === 'package'}"${tab === 'package' ? ' class="on"' : ''}>Package${n ? ` <span class="s2-badge">${n}</span>` : ''}</button></div>`;
  }
  function wireTabs(box) { box.querySelectorAll('.s2-tabs [data-t]').forEach((b) => (b.onclick = () => setTab(b.dataset.t))); }
  function renderInspector() {
    if (!active) return;
    if (!D?.ready) { inspector.replaceChildren(h(`<div class="ins-body"><div class="ins-head"><b>Notes</b></div><section><p class="sub">Notes on scenes show here once the production sheet exists.</p></section></div>`)); return; }
    if (editing) return renderEditor();
    if (tab === 'element' && elSel) return renderElement();
    if (tab === 'look') return renderLook();
    if (tab === 'package') return renderPackage();
    if (tab === 'plan' && planStep()) return renderPlan();
    return renderNotes();
  }

  // ---------- the plan (B4): each scene's line and what's on screen; Approve plan · Ask for changes ----------
  // Plan the scenes is done when the creator approves (the server writes "approved" into the sheet); Build is next
  // only then. Ask for changes sends their words to Claude in the chat and takes the approval out. Approve scene in
  // Polish is a different thing (one built scene's render).
  const planStep = () => getP()?.pipeline?.steps.find((x) => x.id === 'plan') || null;
  const planWaiting = () => Boolean(planStep()?.awaiting);
  let planShown = false; // the panel opened on Plan by itself once while the plan waits
  const onScreen = (s) => s.visual || (s.layout ? `${LAYOUT_NAME[s.layout] || s.layout}${CAMERA_OF[s.layout] ? ` · ${CAMERA_OF[s.layout].toLowerCase()}` : ''}` : '');
  function renderPlan() {
    const ok = D.plan?.approved || null, waiting = planWaiting(), busy = Boolean(getP()?.busy);
    const old = $('#plAsk', inspector), draft = old?.value || '', typing = old && document.activeElement === old;
    const box = h(`<div class="ins-body sc-ins pl-ins">
      ${tabsHtml()}
      <div class="ins-head sub-h"><b>Scene plan</b><span class="sub">${D.scenes.length} scene${D.scenes.length === 1 ? '' : 's'} · ${ok ? `approved${ok.at ? ` ${esc(ago(Date.parse(ok.at)))}` : ''}` : waiting ? 'waiting for your OK' : 'not approved'}</span></div>
      <ol class="pl-list">${D.scenes.map((s) => `<li><button type="button" class="pl-row${s.id === sel ? ' on' : ''}" data-id="${esc(s.id)}">
        <span class="pl-n">${s.n}</span><span class="pl-t"><span class="pl-h"><b>${esc(s.title)}</b><span class="mono sub">${clock(s.start)}</span></span>
        ${s.line ? `<span class="pl-line">“${esc(s.line)}”</span>` : ''}
        <span class="pl-vis"><i>On screen</i> ${esc(onScreen(s) || 'not said yet')}</span></span></button></li>`).join('')}</ol>
      <div class="pl-acts">
        ${ok ? `<p class="pl-ok">✓ Plan approved. Build is next.</p>` : `<button class="btn accent wide" data-a="approve-plan"${busy ? ' disabled title="Claude is working: wait for it to finish first"' : ''}>Approve plan</button>`}
        <label class="pl-lbl" for="plAsk">Ask for changes</label>
        <textarea id="plAsk" rows="3" placeholder="What should change? e.g. In scene 3 show the screen, not me."></textarea>
        <button class="btn wide" data-a="ask-plan">Ask for changes</button>
        <p class="sub">${ok ? 'Asking for changes takes the approval back until you approve the new plan.' : 'Claude changes the plan in the chat; then you approve it.'}</p>
      </div></div>`);
    inspector.replaceChildren(box);
    wireTabs(box);
    const ta = $('#plAsk', box);
    ta.value = draft; if (typing) ta.focus();
    box.querySelectorAll('.pl-row').forEach((b) => (b.onclick = () => select(b.dataset.id)));
    box.querySelector('[data-a=approve-plan]')?.addEventListener('click', async (e) => {
      e.currentTarget.disabled = true;
      try { await api(`/api/projects/${enc}/plan`, { op: 'approve' }); toast('Plan approved. Build is next.'); await update(); }
      catch (err) { toast(err.message); renderInspector(); }
    });
    box.querySelector('[data-a=ask-plan]').addEventListener('click', async (e) => {
      const text = ta.value.trim();
      if (!text) { toast('Say what should change first.'); ta.focus(); return; }
      e.currentTarget.disabled = true;
      try { await api(`/api/projects/${enc}/plan`, { op: 'changes', text }); ta.value = ''; toast('Sent to Claude in the chat.'); await update(); }
      catch (err) { toast(err.message); e.currentTarget.disabled = false; }
    });
  }
  function showPlan() { if (!planStep()) return; tab = 'plan'; planShown = true; renderInspector(); }

  // One line above Send: what's waiting ("1 change waiting: transition Cut → Morph").
  const optLabel = (field, v) => (D.options?.[field === 'layout' ? 'layouts' : field === 'transition' ? 'transitions' : 'backgrounds'] || []).find((x) => x.id === v)?.label || v;
  function itemLine(n) {
    if (n.kind !== 'change') return `note “${n.text.length > 48 ? `${n.text.slice(0, 46)}…` : n.text}”`;
    if (n.field === 'cut') return n.text.replace(/^The cut changed: /, 'cut: ').replace(/ · \d+:\d+\.\d+ → .*$/, '');
    if (['layout', 'transition', 'background'].includes(n.field)) return `${FIELD_NAME[n.field].toLowerCase()} ${optLabel(n.field, n.from) || 'not set'} → ${optLabel(n.field, n.to)}`;
    if (n.field === 'timing' || n.field === 'style') return `${n.target?.label ? `${n.target.label} ` : ''}${FIELD_NAME[n.field].toLowerCase()} ${shortVal(n.to)}`;
    return n.text.charAt(0).toLowerCase() + n.text.slice(1);
  }
  function summaryLine() {
    const items = openItems(), moves = newMoveList(), n = items.length + moves.length;
    if (!n) return '';
    if (n === 1) return items.length ? `1 ${items[0].kind === 'change' ? 'change' : 'note'} waiting: <b>${esc(itemLine(items[0]))}</b>` : `1 move waiting: <b>${esc(moves[0].o.label || moves[0].el)}</b>`;
    const ch = items.filter((x) => x.kind === 'change').length, no = items.length - ch;
    const where = new Set([...items.map((x) => x.scene), ...moves.map((m) => m.scene)].filter((x) => x && x !== '*')), whole = items.some((x) => !x.scene);
    const sc1 = where.size === 1 && !whole ? scene([...where][0]) : null;
    const on = sc1 ? `, all on scene ${sc1.n}` : [where.size && `${where.size} scene${where.size > 1 ? 's' : ''}`, whole && 'the whole video'].filter(Boolean).join(' and ');
    return `${n} waiting: ${[ch && `${ch} change${ch > 1 ? 's' : ''}`, no && `${no} note${no > 1 ? 's' : ''}`, moves.length && `${moves.length} move${moves.length > 1 ? 's' : ''}`].filter(Boolean).join(', ')}${sc1 ? on : on ? ` · ${on}` : ''}`;
  }
  // The package's count as this panel shows it goes to the app at once (onCount), so the dock and the stage list say the
  // same number as "Save changes → Claude · N" here, not the last refresh's (A4).
  function tellOpen(n) {
    if (!D?.ready || getP()?.scenes?.open === n) return;
    onCount?.({ count: D.scenes.length, open: n, done: D.notes.filter((x) => x.status === 'done' || x.status === 'question').length });
  }
  function sendBar() {
    const n = packageCount();
    tellOpen(n);
    return `<div class="s2-send">${n ? `<p class="s2-sum">${summaryLine()}</p>` : ''}<button class="btn accent wide" data-a="send"${n ? '' : ' disabled'}>${ICON.claude}${n ? `Save changes → Claude · ${n}` : 'Nothing waiting for Claude'}</button>
      ${n ? '<button class="btn ghost small wide" data-a="pkg">See what\'s in it</button>' : ''}</div>`;
  }
  function wireSend(box) {
    box.querySelector('[data-a=send]')?.addEventListener('click', () => applyNotes());
    box.querySelector('[data-a=pkg]')?.addEventListener('click', () => setTab('package'));
  }

  function renderNotes() {
    const s = scene(sel);
    const old = $('#ncText', inspector), draft = old?.value || '', typing = old && document.activeElement === old;
    const caret = typing ? [old.selectionStart, old.selectionEnd] : null;
    const list = realNotes(s.id);
    const t = pin ? pin.t : playerTime() ?? s.start;
    const box = h(`<div class="ins-body sc-ins">
      ${tabsHtml()}
      <div class="ins-head sub-h"><b>Notes</b><span class="sub">${mode === 'full' && isPlaying() ? `Now playing · ${esc(sectionOf(s.id)?.label || `scene ${s.n}`)}` : `scene ${s.n} · ${list.filter((n) => n.status !== 'resolved').length}`}</span></div>
      <div class="nc-list" id="ncList"></div>
      <div class="nc-compose">
        ${replyTo ? `<div class="nc-chip">Reply to note ${numberOf(D.notes.find((n) => n.id === replyTo) || {}) || ''}<button class="x" data-a="unreply" aria-label="Cancel reply">✕</button></div>` : ''}
        ${pin ? `<div class="nc-chip pinned">${ICON.pin}Pinned at ${clock(pin.t)}${pin.el ? ` · on ${esc(pin.el.label)}` : ''}<button class="x" data-a="unpin" aria-label="Remove the pin">✕</button></div>` : ''}
        <label class="vh" for="ncText">New note</label>
        <textarea id="ncText" rows="2" placeholder="Add a note at ${clock(t)}… (click the paused picture to pin it to a spot)"></textarea>
        <div class="nc-row"><span class="sub">${s.n} · ${esc(s.title)}</span><span class="gap"></span><button class="btn small" id="ncAdd">Add note</button></div>
      </div>
      <div class="nc-actions">${sendBar()}${!builtSc(s) ? `${mode === 'full' ? '<button class="btn wide" id="ncOpen" title="See this scene on its own, with its timeline">Open this scene</button>' : ''}<p class="sub nc-nb">Not built yet: no render has this scene, so there is nothing to approve. The take plays here, on the cut.</p>`
        : mode === 'full' ? `<div class="nc-two"><button class="btn" id="ncOpen" title="See this scene on its own, with its timeline">Open this scene</button><button class="btn" id="ncApprove">${D.approved[s.id] ? 'Approved ✓' : 'Approve scene'}</button></div>` : `<button class="btn wide" id="ncApprove">${D.approved[s.id] ? 'Approved ✓ · undo' : 'Approve scene'}</button>`}</div></div>`);
    inspector.replaceChildren(box);
    wireTabs(box); wireSend(box);
    const ta = $('#ncText', box);
    ta.value = draft;
    if (typing) { ta.focus(); ta.setSelectionRange(...caret); }
    const nl = $('#ncList', box);
    if (!list.length) nl.append(h(`<p class="sub nc-empty">No notes on this scene yet. Watch it, then type what you want changed. Click the paused picture first to pin the note to a spot.</p>`));
    for (const n of list) nl.append(noteCard(n));
    const add = async () => {
      const text = ta.value.trim();
      if (!text) return ta.focus();
      const at = pin ? pin.t : playerTime() ?? s.start;
      const body = { op: 'add', text, t: at, scene: pin ? pin.scene : sceneAt(at).id, render: renderFile, on: mode === 'full' ? 'render' : 'scene' };
      if (pin) { body.pos = pin.pos; if (pin.el) body.el = pin.el; }
      const re = replyTo && D.notes.find((n) => n.id === replyTo);
      if (re) { body.re = re.id; if (!pin && re.pos) body.pos = re.pos; if (!pin && re.t != null) body.t = re.t; body.scene = re.scene; if (!pin && re.el) body.el = re.el; }
      $('#ncAdd', box).disabled = true;
      try {
        took(await api(`/api/projects/${enc}/notes`, body));
        pin = null; replyTo = null; ta.value = '';
        paint();
        $('#ncText', inspector)?.focus();
      } catch (e) { toast(e.message); $('#ncAdd', box).disabled = false; }
    };
    $('#ncAdd', box).onclick = add;
    ta.onkeydown = (e) => { if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); add(); } if (e.key === 'Escape') { pin = null; replyTo = null; renderInspector(); } };
    box.querySelector('[data-a=unpin]')?.addEventListener('click', () => { pin = null; renderInspector(); if (player) player.pins.dataset.sig = ''; });
    box.querySelector('[data-a=unreply]')?.addEventListener('click', () => { replyTo = null; renderInspector(); });
    box.querySelector('#ncApprove')?.addEventListener('click', () => approve());
    box.querySelector('#ncOpen')?.addEventListener('click', () => setMode('scene'));
    if (player) player.pins.dataset.sig = '';
  }
  async function approve() {
    const s = scene(sel);
    if (!builtSc(s) && !D.approved[s.id]) { toast(`Scene ${s.n} isn't built yet: there's no render of it to approve.`); return; }
    try { took(await api(`/api/projects/${enc}/notes`, { op: D.approved[s.id] ? 'unapprove' : 'approve', scene: s.id })); paint(); }
    catch (e) { toast(e.message); }
  }
  const focusComposer = () => setTimeout(() => $('#ncText', inspector)?.focus(), 0);

  function noteCard(n) {
    const k = numberOf(n);
    // On the video's clock (as it plays), like the Package, the note box and every other time the creator reads.
    const when = [n.t != null ? `at ${clock(n.t)}` : '', n.el ? `on ${n.el.label}` : n.pos ? 'pinned' : '', n.version || ''].filter(Boolean).join(' · ');
    const state = { open: 'In the change package', sent: 'Sent · Claude is on it', resolved: 'Resolved' }[n.status] || '';
    const card = h(`<div class="nc ${esc(n.status)}${n.id === noteSel ? ' on' : ''}" data-id="${esc(n.id)}">
      <div class="nc-top"><span class="pin-n ${esc(n.status)}">${k}</span><b>${n.re ? 'Reply' : 'You'}</b><span class="mono sub">${esc(when)}</span><span class="gap"></span>
        <button class="btn ghost small nc-del" aria-label="Delete note ${k}" title="Delete this note">✕</button></div>
      <div class="nc-text">${esc(n.text)}</div>
      ${n.reply ? `<div class="nc-reply"><div class="nc-who">${ICON.claude}Claude${n.status === 'question' ? ' asks' : ''}</div><div>${esc(n.reply)}</div></div>` : ''}
      ${state ? `<div class="nc-state sub">${n.status === 'sent' ? '<span class="spin"></span>' : ''}${esc(state)}</div>` : ''}
      ${n.status === 'done' || n.status === 'question' ? `<div class="nc-btns">${n.status === 'done' ? '<button class="btn dark small" data-a="ok">Looks good</button>' : ''}<button class="btn small" data-a="reply">Reply</button></div>` : ''}
    </div>`);
    card.onclick = (e) => { if (e.target.closest('button')) return; noteSel = n.id; if (n.t != null) seekTo(n.t); renderInspector(); };
    $('.nc-del', card).onclick = () => removeItem(n);
    card.querySelector('[data-a=ok]')?.addEventListener('click', async () => {
      try { took(await api(`/api/projects/${enc}/notes`, { op: 'update', id: n.id, status: 'resolved' })); paint(); } catch (e) { toast(e.message); }
    });
    card.querySelector('[data-a=reply]')?.addEventListener('click', () => { replyTo = n.id; pin = null; setTab('notes'); focusComposer(); });
    return card;
  }
  async function removeItem(n) {
    if (n.status === 'sent' && !confirm('Claude is working on this. Delete it anyway?')) return;
    try { took(await api(`/api/projects/${enc}/notes`, { op: 'delete', id: n.id })); paint(); } catch (e) { toast(e.message); }
  }

  // ---- Look: layout, background, transition, sound effects (each a change in the package) ----
  let soundOpen = false;
  function renderLook() {
    const s = scene(sel), opt = D.options || { layouts: [], backgrounds: [], transitions: [], sounds: [] };
    const pend = (field) => openChange(s.id, field);
    const cur = { layout: s.layout, transition: s.transition && s.transition !== 'none' ? s.transition : 'cut', background: s.background };
    const val = (field) => pend(field)?.to ?? cur[field];
    const waiting = (field) => (pend(field) ? `<p class="lk-wait">Changed from ${esc(labelOf(field, pend(field).from ?? cur[field]))} · waiting for Claude</p>` : '');
    const labelOf = (field, v) => (opt[field === 'layout' ? 'layouts' : field === 'transition' ? 'transitions' : 'backgrounds'] || []).find((x) => x.id === v)?.label || v || 'not set';
    const bgTile = (b) => {
      const on = val('background') === b.id, pending = on && pend('background');
      const pic = b.kind === 'preset' ? `<span class="bgs ${esc(b.id)}" aria-hidden="true"></span>`
        : b.kind === 'library' && /\.(png|jpe?g|webp|gif)$/i.test(b.file || '') ? `<img class="bgs" alt="" src="/api/library/backgrounds/${encodeURIComponent(b.file)}">`
        : `<span class="bgs file" aria-hidden="true">${esc((b.file || b.id).split('.').pop())}</span>`;
      return `<button class="bgt${on ? ' on' : ''}${pending ? ' pending' : ''}" data-bg="${esc(b.id)}" aria-pressed="${on}" title="${esc(b.label)}">${pic}<span>${esc(b.label)}</span></button>`;
    };
    const sfx = sfxOf(s);
    const box = h(`<div class="ins-body sc-ins look">
      ${tabsHtml()}
      <div class="ins-head sub-h"><b>Look</b><span class="sub">scene ${s.n} · ${esc(s.title)}</span></div>
      <section><h3>Layout</h3><div class="tiles lk-tiles">${opt.layouts.map((l) => { const on = val('layout') === l.id; return `<button class="pz${on ? ' on' : ''}${on && pend('layout') ? ' pending' : ''}" data-layout="${esc(l.id)}" aria-pressed="${on}">${glyph(l.id)}<span>${esc(l.label)}</span></button>`; }).join('')}</div>${waiting('layout')}</section>
      <section><h3>Background</h3><div class="bg-grid">${opt.backgrounds.map(bgTile).join('')}</div>${waiting('background') || (!cur.background ? '<p class="sub">Not set in the production sheet; the scene uses the project\'s theme.</p>' : '')}</section>
      <section><h3>Transition in</h3><div class="seg wide lk-tr" role="group" aria-label="Transition in">${opt.transitions.map((x) => { const on = val('transition') === x.id; return `<button data-tr="${esc(x.id)}" aria-pressed="${on}" class="${on ? 'on' : ''}${on && pend('transition') ? ' pending' : ''}">${esc(x.label)}</button>`; }).join('')}</div>${waiting('transition')}</section>
      <section><h3>Sound effects</h3><div class="sfx-list">${sfx.length ? sfx.map((x) => {
        const f = x.file || soundFile(x.label), lv = openChange(s.id, 'level', x.label), db = lv ? lv.to : x.db;
        return `<div class="sfx-row${x.waiting ? ' waiting' : ''}"><button class="sfx-pl" data-sp="${esc(f || '')}" data-db="${db ?? 0}"${f ? '' : ' disabled'} aria-label="Play ${esc(x.label)}" title="${f ? `Play ${esc(x.label)}` : 'Not in your library: Claude has the file'}">${ICON.play}</button>
          <span class="ln"><b>${esc(x.label)}</b><small>${x.t != null ? `at ${clock(x.t)}` : 'time not in the sheet'}${x.waiting ? ' · waiting for Claude' : ''}</small></span>
          ${x.added ? '' : `<label class="vh" for="lv-${esc(squash(x.label))}">Level of ${esc(x.label)}</label><select class="sfx-lv${lv ? ' pending' : ''}" id="lv-${esc(squash(x.label))}" data-lv="${esc(x.label)}" title="Level, on top of the default (about 7 dB under your voice)${lv ? ' · waiting for Claude' : ''}">
            <option value=""${db == null ? ' selected' : ''}>${x.db == null ? 'Level as set' : dbText(x.db)}</option>${LEVELS.filter((d) => d !== x.db).map((d) => `<option value="${d}"${db === d ? ' selected' : ''}>${dbText(d)}</option>`).join('')}</select>`}
          <button class="btn ghost small" data-sfx="${esc(x.label)}" aria-label="${x.waiting ? 'Undo' : 'Remove'} ${esc(x.label)}">${x.waiting ? 'Undo' : '✕'}</button></div>`;
      }).join('') : '<p class="sub">No sound effects in this scene.</p>'}</div>
        <button class="btn ghost wide" data-a="addsfx" aria-expanded="${soundOpen}">+ Add a sound</button>
        ${soundOpen ? `<div class="sfx-pick">${opt.sounds.length ? opt.sounds.map((x) => `<div class="sfx-row"><button class="btn ghost small" data-play="${esc(x.file)}" aria-label="Play ${esc(x.name)}">▶</button><span class="ln"><b>${esc(x.name)}</b>${x.note ? `<small>${esc(x.note)}</small>` : ''}</span><button class="btn small" data-add="${esc(x.file)}" data-name="${esc(x.name)}">Add at ${clock(playerTime())}</button></div>`).join('')
          : '<p class="sub">Your library has no sounds yet. Add some on the Library page, or ask Claude to find one.</p>'}</div>` : ''}
        <p class="sub">Your voice always stays on top of the effects.</p></section>
      <div class="nc-actions">${sendBar()}</div></div>`);
    inspector.replaceChildren(box);
    wireTabs(box); wireSend(box);
    box.querySelectorAll('[data-layout]').forEach((b) => (b.onclick = () => change('layout', cur.layout || null, b.dataset.layout, { on: 'look' })));
    box.querySelectorAll('[data-bg]').forEach((b) => (b.onclick = () => change('background', cur.background || null, b.dataset.bg, { on: 'look' })));
    box.querySelectorAll('[data-tr]').forEach((b) => (b.onclick = () => change('transition', cur.transition || null, b.dataset.tr, { on: 'look' })));
    box.querySelectorAll('[data-sfx]').forEach((b) => (b.onclick = () => {
      const label = b.dataset.sfx;
      const pendingN = D.notes.find((n) => n.kind === 'change' && n.status === 'open' && n.scene === s.id && n.field === 'sfx' && (n.to?.add === label || n.to?.remove === label));
      if (pendingN) return removeItem(pendingN);
      change('sfx', null, { remove: label }, { on: 'look' });
    }));
    $('[data-a=addsfx]', box).onclick = () => { soundOpen = !soundOpen; renderInspector(); };
    let audio = null;
    box.querySelectorAll('[data-sp]').forEach((b) => (b.onclick = () => { audio?.pause(); audio = new Audio(`/api/library/file?f=${encodeURIComponent(b.dataset.sp)}`); audio.volume = Math.min(1, 0.45 * 10 ** (Number(b.dataset.db || 0) / 20)); audio.play().catch(() => toast('Couldn\'t play that sound.')); }));
    box.querySelectorAll('[data-lv]').forEach((x) => (x.onchange = () => {
      const label = x.dataset.lv, base = sfx.find((y) => y.label === label)?.db ?? null, v = x.value === '' ? base : Number(x.value);
      change('level', base, v, { target: { id: label, label }, on: 'look' });
    }));
    box.querySelectorAll('[data-play]').forEach((b) => (b.onclick = () => { audio?.pause(); audio = new Audio(`/api/library/file?f=${encodeURIComponent(b.dataset.play)}`); audio.play().catch(() => toast('Couldn\'t play that sound.')); }));
    box.querySelectorAll('[data-add]').forEach((b) => (b.onclick = () => { soundOpen = false; change('sfx', null, { add: b.dataset.name, file: b.dataset.add, t: Math.round(playerTime() * 100) / 100 }, { on: 'look' }); }));
  }

  // ---- an element (a kit graphic): place (instant), text, type, colour and timing (into the package) ----
  function renderElement() {
    const s = scene(sel), c = samples.clips.find((x) => x.id === elSel);
    if (!c) { tab = 'look'; elSel = null; return renderLook(); }
    const style = openChange(s.id, 'style', c.id)?.to || {}, text = openChange(s.id, 'text', c.id)?.to;
    const tim = openChange(s.id, 'timing', c.id)?.to, enter = openChange(s.id, 'enter', c.id)?.to, leave = openChange(s.id, 'leave', c.id)?.to;
    const k = { id: c.id, scene: s.id, label: c.label };
    const ov = placeOf(k);
    const box = h(`<div class="ins-body sc-ins el-panel">
      ${tabsHtml()}
      <div class="ins-head sub-h"><span class="sel-dot"></span><b>${esc(c.label)}</b><span class="mono sub">${esc(c.id)}</span><span class="gap"></span><button class="btn ghost small" data-a="close" aria-label="Back to the scene's look">✕</button></div>
      <section><h3>Place</h3>
        <div class="ed-grid"><label>X<input class="field num" type="number" id="elX" step="1" value="${Math.round(ov.dx)}"></label><label>Y<input class="field num" type="number" id="elY" step="1" value="${Math.round(ov.dy)}"></label></div>
        <label class="slider"><span>Size</span><input type="range" id="elS" min="0.2" max="3" step="0.01" value="${ov.scale}"><span class="val">${Math.round(ov.scale * 100)}%</span></label>
        <div class="row"><span>Applies to</span><div class="seg" id="elScope" role="group" aria-label="Which scenes"><button data-s="scene">This scene</button><button data-s="all">Every scene</button></div></div>
        <button class="btn wide" data-a="move">${ICON.edit}Move it on the picture</button>
        <p class="sub">Moving and resizing show straight away in Edit graphics, and go in the package so the next render has them.${ov.keyed ? ' Keyframed: these change the keyframe at the playhead (or add one there).' : ''}</p></section>
      ${keysHtml(k)}
      <section><h3>Text</h3><label class="vh" for="elT">New words</label><input class="field" id="elT" placeholder="New words for this element" value="${esc(text || '')}">${text ? '<p class="lk-wait">Waiting for Claude</p>' : ''}</section>
      <section><h3>Type</h3>
        <div class="el-type"><label class="vh" for="elF">Font</label><select class="field" id="elF"><option value="">Keep the font</option>${FONTS.map((f) => `<option${style.font === f ? ' selected' : ''}>${esc(f)}</option>`).join('')}</select>
          <label class="vh" for="elZ">Size in pixels</label><input class="field num" id="elZ" type="number" min="8" max="400" placeholder="px" value="${esc(style.size ?? '')}"></div>
        <div class="seg wide" id="elW" role="group" aria-label="Weight">${WEIGHTS.map(([w, n]) => `<button data-w="${w}" class="${String(style.weight) === w ? 'on' : ''}" aria-pressed="${String(style.weight) === w}">${n}</button>`).join('')}</div>
        <div class="el-colors" role="group" aria-label="Colour">${STYLE_COLORS.map(([hex, n]) => `<button class="sw-c${style.color === hex ? ' on' : ''}" data-c="${hex}" style="background:${hex}" aria-label="${n}" aria-pressed="${style.color === hex}" title="${n}"></button>`).join('')}</div>
        ${Object.keys(style).length ? `<p class="lk-wait">${esc(showVal(style))} · waiting for Claude</p>` : ''}</section>
      <section><h3>Timing</h3>
        <div class="ed-grid"><label>In<input class="field num" type="number" step="0.01" id="elIn" value="${(tim?.in ?? c.runs[0].in).toFixed(2)}"></label><label>Out<input class="field num" type="number" step="0.01" id="elOut" value="${(tim?.out ?? c.runs[0].out).toFixed(2)}"></label></div>
        ${c.runs.length > 1 ? `<p class="sub">Shows ${c.runs.length} times: ${c.runs.map((r) => `${c2(r.in)}–${c2(r.out)}`).join(', ')}. These fields set the first; drag a clip on the timeline for the others.</p>` : ''}
        <div class="ed-grid el-motion"><label>Enters<select class="field" id="elEn">${MOTIONS.map(([v, n]) => `<option value="${v}"${(enter || '') === v ? ' selected' : ''}>${n}</option>`).join('')}</select></label>
          <label>Leaves<select class="field" id="elLv">${MOTIONS.filter(([v]) => v !== 'type').map(([v, n]) => `<option value="${v}"${(leave || '') === v ? ' selected' : ''}>${n}</option>`).join('')}</select></label></div>
        ${enter || leave ? `<p class="lk-wait">${[enter && `enters: ${esc(MOTIONS.find((m) => m[0] === enter)?.[1] || enter)}`, leave && `leaves: ${esc(MOTIONS.find((m) => m[0] === leave)?.[1] || leave)}`].filter(Boolean).join(' · ')} · waiting for Claude</p>` : ''}
        <p class="sub">${tim ? 'New timing waiting for Claude. ' : ''}Or drag the clip's edges on the timeline; they snap to words. How it enters and leaves goes to Claude.</p></section>
      <section><h3>Note on this element</h3><label class="vh" for="elN">Note</label><textarea class="field" id="elN" rows="2" placeholder="What should change about ${esc(c.label)}?"></textarea>
        <button class="btn small" data-a="note">Add note</button></section>
      ${kitBehind() && !kitOld() ? '<p class="sub el-kit">This project has scene kit 2. <button class="btn ghost small" data-a="kit3">Update the scene kit</button> to see elements under their parent and the type bar on text (it only adds that).</p>' : ''}
      <div class="nc-actions">${sendBar()}</div></div>`);
    inspector.replaceChildren(box);
    wireTabs(box); wireSend(box);
    $('[data-a=close]', box).onclick = () => { elSel = null; setTab('look'); };
    $('#elX', box).onchange = (e) => setPlace(k, { dx: Math.round(Number(e.target.value) || 0) });
    $('#elY', box).onchange = (e) => setPlace(k, { dy: Math.round(Number(e.target.value) || 0) });
    $('#elS', box).oninput = (e) => { $('.val', e.target.parentElement).textContent = `${Math.round(Number(e.target.value) * 100)}%`; };
    $('#elS', box).onchange = (e) => setPlace(k, { scale: Number(e.target.value) });
    wireKeys(box, k);
    const sc = scopeOf(k);
    box.querySelectorAll('#elScope button').forEach((b) => { b.classList.toggle('on', b.dataset.s === sc); b.setAttribute('aria-pressed', String(b.dataset.s === sc)); b.onclick = () => moveScope(k, b.dataset.s); });
    $('[data-a=move]', box).onclick = () => { startEditing(); edSel = { id: c.id, scene: s.id, label: c.label }; paintBoxes(); };
    const tgt = { target: { id: c.id, label: c.label }, on: 'element' };
    $('#elT', box).onchange = (e) => change('text', null, e.target.value.trim() || null, tgt);
    const styleChange = (patch) => { const next = { ...style, ...patch }; for (const key of Object.keys(next)) if (next[key] === '' || next[key] == null) delete next[key]; change('style', null, Object.keys(next).length ? next : null, tgt); };
    $('#elF', box).onchange = (e) => styleChange({ font: e.target.value || null });
    $('#elZ', box).onchange = (e) => styleChange({ size: e.target.value ? Math.round(Number(e.target.value)) : null });
    box.querySelectorAll('#elW button').forEach((b) => (b.onclick = () => styleChange({ weight: String(style.weight) === b.dataset.w ? null : b.dataset.w })));
    box.querySelectorAll('.sw-c').forEach((b) => (b.onclick = () => styleChange({ color: style.color === b.dataset.c ? null : b.dataset.c })));
    const timing = () => { const a = Number($('#elIn', box).value), z = Number($('#elOut', box).value); if (Number.isFinite(a) && Number.isFinite(z) && z > a) change('timing', { in: Math.round(c.runs[0].in * 100) / 100, out: Math.round(c.runs[0].out * 100) / 100 }, { in: a, out: z }, { ...tgt, target: runTarget(c, 0) }); };
    $('#elIn', box).onchange = timing; $('#elOut', box).onchange = timing;
    $('#elEn', box).onchange = (e) => change('enter', null, e.target.value || null, tgt);
    $('#elLv', box).onchange = (e) => change('leave', null, e.target.value || null, tgt);
    box.querySelector('[data-a=kit3]')?.addEventListener('click', async () => { if (await ensureKit(true, true)) renderInspector(); });
    $('[data-a=note]', box).onclick = async () => {
      const t = $('#elN', box).value.trim();
      if (!t) return $('#elN', box).focus();
      const at = playerTime(), [W, H] = D.frame;
      const hit = nearestHit(c.id, at);
      const body = { op: 'add', text: t, t: at, scene: s.id, render: renderFile, on: 'scene', el: { id: c.id, label: c.label } };
      if (hit) body.pos = { x: (hit.x + hit.w / 2) / W, y: (hit.y + hit.h / 2) / H };
      try { took(await api(`/api/projects/${enc}/notes`, body)); paint(); toast('Note added to the change package.'); } catch (e) { toast(e.message); }
    };
  }
  function nearestHit(eid, t) {
    let best = null, bd = Infinity;
    samples.times.forEach((x, i) => { const k = samples.hits[i]?.find((y) => y.id === eid); if (k && Math.abs(x - t) < bd) { bd = Math.abs(x - t); best = k; } });
    return best;
  }

  // ---- Package: everything waiting for Claude, by scene; what Claude will get; send ----
  function renderPackage() {
    const waiting = openItems(), moves = newMoveList();
    const sent = D.notes.filter((n) => n.status === 'sent'), done = D.notes.filter((n) => n.status === 'done' || n.status === 'question');
    const items = pkgFilter === 'waiting' ? waiting : pkgFilter === 'sent' ? sent : done;
    const order = (sid) => D.scenes.findIndex((s) => s.id === sid);
    const groups = new Map();
    for (const n of items) { const k = n.scene ?? ''; if (!groups.has(k)) groups.set(k, []); groups.get(k).push(n); }
    if (pkgFilter === 'waiting') for (const m of moves) { const k = m.scene === '*' ? '*' : m.scene; if (!groups.has(k)) groups.set(k, []); groups.get(k).push({ move: m }); }
    const keys = [...groups.keys()].sort((a, b) => (a === '*' ? 1e6 : order(a)) - (b === '*' ? 1e6 : order(b)));
    const total = waiting.length + moves.length;
    const box = h(`<div class="ins-body sc-ins pkg">
      ${tabsHtml()}
      <div class="ins-head sub-h"><b>Change package</b><span class="sub">${total ? `${total} waiting` : 'nothing waiting'}</span></div>
      <div class="seg wide pkg-f" role="group" aria-label="Show">${[['waiting', `Waiting ${total}`], ['sent', `Sent ${sent.length}`], ['done', `Done ${done.length}`]].map(([k, l]) => `<button data-f="${k}" class="${pkgFilter === k ? 'on' : ''}" aria-pressed="${pkgFilter === k}">${l}</button>`).join('')}</div>
      <div class="pkg-list"></div>
      ${pkgFilter === 'waiting' && total && firstOf() ? `<label class="toggle pkg-first"><input type="checkbox" role="switch" id="pkgFirst"${firstScene === firstOf().id ? ' checked' : ''}><span class="sw" aria-hidden="true"></span><span><b>Show me scene ${firstOf().n} first</b><small>A short preview before the full render.</small></span></label>` : ''}
      ${pkgFilter === 'waiting' && total ? `<details class="pkg-brief"${preview.open ? ' open' : ''}><summary>What Claude gets</summary><pre class="mono">${esc(preview.text || 'Loading…')}</pre></details>` : ''}
      <div class="pkg-hist"></div>
      <div class="nc-actions">${pkgFilter === 'waiting' ? sendBar().replace('<button class="btn ghost small wide" data-a="pkg">See what\'s in it</button>', '') : ''}
        ${(() => { const t = pkgFilter === 'waiting' ? 'Claude confirms it got the package, then ticks off each item with a reply. Claude also knows what\'s waiting, so "send them" in the chat works too.'
          : pkgFilter === 'sent' ? (sent.length ? 'Claude is working on these.' : '') : done.length ? 'Claude\'s replies: check each one and press Looks good, or reply.' : '';
          return t ? `<p class="sub">${t}</p>` : ''; })()}</div></div>`); // (only what's true: no "working on these" under an empty list)
    inspector.replaceChildren(box);
    wireTabs(box); wireSend(box);
    box.querySelectorAll('.pkg-f [data-f]').forEach((b) => (b.onclick = () => { pkgFilter = b.dataset.f; renderInspector(); }));
    const list = $('.pkg-list', box);
    if (!keys.length) list.append(h(`<p class="sub nc-empty">${pkgFilter === 'waiting' ? 'Nothing waiting. Notes, changes from the Look tab, timing you drag on the scene timeline, an element\'s text, font or colour, and moves all collect here until you send them.' : pkgFilter === 'sent' ? 'Nothing with Claude right now.' : 'No replies yet.'}</p>`));
    for (const k of keys) {
      const s = k === '*' ? null : scene(k), its = groups.get(k), th = s && thumbs.get(`${renderFile}|${s.id}`);
      const nCh = its.filter((x) => x.move || x.kind === 'change').length, nNo = its.length - nCh;
      const count = [nCh && `${nCh} change${nCh > 1 ? 's' : ''}`, nNo && `${nNo} note${nNo > 1 ? 's' : ''}`].filter(Boolean).join(' · ');
      const g = h(`<div class="pkg-g"><div class="pkg-gh">${s ? `<button class="pkg-th" aria-label="Show scene ${s.n}">${th ? `<img alt="" src="${th}">` : ''}<span>${s.n}</span></button><span class="pkg-gt"><b>${s.n} · ${esc(s.title)}</b><span class="sub">${esc(sectionOf(s.id)?.label ? `${sectionOf(s.id).label} · ` : '')}<span class="mono">${clock(s.start)} – ${clock(s.end)}</span></span></span>`
        : `<span class="pkg-gt"><b>${k === '*' ? 'Every scene' : 'Whole video'}</b></span>`}<span class="gap"></span><span class="sub">${count}</span></div></div>`);
      g.querySelector('.pkg-th')?.addEventListener('click', () => { select(s.id); seekTo(s.start + Math.min((s.end - s.start) * 0.4, 2)); });
      for (const it of its) g.append(it.move ? moveRow(it.move) : itemRow(it));
      list.append(g);
    }
    box.querySelector('#pkgFirst')?.addEventListener('change', (e) => { firstScene = e.target.checked ? firstOf().id : null; preview.key = ''; const det = $('.pkg-brief', box); if (det?.open) loadPreview(det); });
    paintHistory($('.pkg-hist', box));
    const det = $('.pkg-brief', box);
    if (det) {
      det.addEventListener('toggle', () => { preview.open = det.open; if (det.open) loadPreview(det); });
      if (det.open) loadPreview(det);
    }
  }
  // "Show me scene N first": the scene the package starts with (the one you're on when it has items).
  function firstOf() {
    const sids = new Set([...openItems().map((n) => n.scene), ...newMoveList().map((m) => m.scene)].filter((x) => x && x !== '*'));
    if (!sids.size) return null;
    return sids.has(sel) ? scene(sel) : D.scenes.find((x) => sids.has(x.id)) || null;
  }
  const firstNow = () => (firstScene && firstOf()?.id === firstScene ? firstScene : null);
  // Earlier packages: what was sent together (the notes' sent time), and the render that came back with them.
  function paintHistory(box) {
    if (!box) return;
    const by = new Map();
    for (const n of D.notes) if (n.sent_at && n.status !== 'open') { if (!by.has(n.sent_at)) by.set(n.sent_at, []); by.get(n.sent_at).push(n); }
    const packs = [...by.entries()].sort((a, b) => Date.parse(a[0]) - Date.parse(b[0])).map(([at, list], i) => ({ at, list, k: i + 1 })).reverse().slice(0, 6);
    if (!packs.length) { box.replaceChildren(); return; }
    const hm = (iso) => new Date(iso).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
    box.replaceChildren(h(`<h4 class="pkg-hh">Earlier packages</h4>`), ...packs.map((p) => {
      const ch = p.list.filter((n) => n.kind === 'change').length, no = p.list.length - ch, busy = p.list.some((n) => n.status === 'sent');
      const r = [...D.renders].reverse().find((x) => x.at > Date.parse(p.at));
      const state = busy ? 'with Claude' : r ? `done in ${versionName(r.file)}` : 'done';
      const replies = p.list.filter((n) => n.reply);
      const el = h(`<details class="pkg-p${busy ? ' busy' : ''}"><summary><span class="pkg-pi" aria-hidden="true">${busy ? '<span class="spin"></span>' : '✓'}</span><span class="pkg-ps"><b>Package ${p.k}</b><span class="sub">sent ${esc(hm(p.at))} · ${[no && `${no} note${no > 1 ? 's' : ''}`, ch && `${ch} change${ch > 1 ? 's' : ''}`].filter(Boolean).join(', ')} · ${esc(state)}</span></span>${replies.length ? '<span class="pkg-rp">Replies ▾</span>' : ''}</summary>
        <div class="pkg-pl">${p.list.map((n) => `<div class="pkg-pr"><b>${esc(n.kind === 'change' ? itemLine(n) : n.text)}</b>${n.reply ? `<span>${ICON.claude}${esc(n.reply)}</span>` : `<span class="sub">${esc({ sent: 'Claude is on it', done: 'Done', question: 'Claude asks', resolved: 'Resolved' }[n.status] || n.status)}</span>`}</div>`).join('')}</div></details>`);
      return el;
    }));
  }
  async function loadPreview(det) {
    const key = `${D.notes.filter((n) => n.status === 'open').map((n) => n.id + JSON.stringify(n.to ?? n.text)).join()}|${newMoveList().length}|${firstNow()}`;
    if (preview.key === key && preview.text) { $('pre', det).textContent = preview.text; return; }
    try { const r = await api(`/api/projects/${enc}/apply-notes`, { preview: true, first: firstNow() }); preview = { ...preview, key, text: r.text }; $('pre', det).textContent = r.text; }
    catch (e) { $('pre', det).textContent = e.message; }
  }
  function itemRow(n) {
    const ch = n.kind === 'change';
    const src = SRC_LABEL[n.on] || (ch ? 'change' : 'note');
    const row = h(`<div class="pkg-i ${esc(n.status)}">
      <span class="pkg-ic" aria-hidden="true">${ch ? FIELD_ICON[n.field] || '•' : '✎'}</span>
      <span class="pkg-t"><b>${esc(ch && n.field !== 'sfx' && FIELD_NAME[n.field] ? `${FIELD_NAME[n.field]}${n.target?.label ? ` · ${n.target.label}` : ''}` : n.text)}</b>
        <span class="sub">${ch ? `${esc(src)}${n.status === 'open' ? ' · waiting for Claude' : ''}` : `Note${n.t != null ? ` · at ${clock(n.t)}` : ''}${n.el ? ` · on ${esc(n.el.label)}` : n.pos ? ' · pinned' : ''}`}</span>
        ${ch && n.from != null && n.field !== 'sfx' ? `<span class="pkg-ft"><span>${esc(shortVal(n.from))}</span>→<span class="to">${esc(shortVal(n.to))}</span></span>` : ''}
        ${n.reply ? `<span class="nc-reply"><span class="nc-who">${ICON.claude}Claude</span>${esc(n.reply)}</span>` : ''}
        ${n.status === 'sent' ? '<span class="nc-state sub"><span class="spin"></span>Claude is on it</span>' : ''}</span>
      <span class="pkg-a">${n.status === 'done' ? '<button class="btn dark small" data-a="ok">Looks good</button>' : ''}<button class="btn ghost small" data-a="show">Show</button>${n.status === 'open' ? `<button class="btn ghost small" data-a="del" aria-label="Take this out of the package">✕</button>` : ''}</span></div>`);
    row.querySelector('[data-a=show]').onclick = () => { if (n.scene) select(n.scene); if (n.t != null) seekTo(n.t); if (ch && n.target && mode === 'scene') { ensureSamples(); pickElement(n.target.id); } else setTab(ch ? 'look' : 'notes'); };
    row.querySelector('[data-a=del]')?.addEventListener('click', () => removeItem(n));
    row.querySelector('[data-a=ok]')?.addEventListener('click', async () => { try { took(await api(`/api/projects/${enc}/notes`, { op: 'update', id: n.id, status: 'resolved' })); paint(); } catch (e) { toast(e.message); } });
    return row;
  }
  function moveRow(m) {
    const o = m.o, parts = [];
    if (o.dx) parts.push(`${Math.abs(o.dx)} px ${o.dx > 0 ? 'right' : 'left'}`);
    if (o.dy) parts.push(`${Math.abs(o.dy)} px ${o.dy > 0 ? 'down' : 'up'}`);
    if (o.scale && o.scale !== 1) parts.push(`${Math.round(o.scale * 100)}% size`);
    const row = h(`<div class="pkg-i open"><span class="pkg-ic" aria-hidden="true">✥</span>
      <span class="pkg-t"><b>${esc(o.label || m.el)} · ${esc(parts.join(', ') || 'moved')}</b><span class="sub">Move · shows now in Edit graphics, baked in on the next render</span></span>
      <span class="pkg-a"><button class="btn ghost small" data-a="del" aria-label="Put it back">✕</button></span></div>`);
    row.querySelector('[data-a=del]').onclick = async () => {
      try { const doc = await api(`/api/projects/${enc}/overrides`, { scene: m.scene, el: m.el, ov: null }); changes++; D.overrides = withPending(doc); preview.key = ''; paintEls(true); paint(); } catch (e) { toast(e.message); }
    };
    return row;
  }

  async function applyNotes() {
    try {
      const r = await api(`/api/projects/${enc}/apply-notes`, { first: firstNow() });
      firstScene = null;
      const parts = [r.notes && `${r.notes} note${r.notes > 1 ? 's' : ''}`, r.changes && `${r.changes} change${r.changes > 1 ? 's' : ''}`, r.moves && `${r.moves} move${r.moves > 1 ? 's' : ''}`].filter(Boolean);
      toast(`Sent the change package to Claude: ${parts.join(', ')}. Follow along in the chat.`);
      pkgFilter = 'sent';
      await update();
    } catch (e) { toast(e.message); }
  }

  // ---------- Edit graphics: the scene's HTML at this moment, with its elements to drag and resize ----------
  function startEditing() {
    if (!player) return;
    if (!D.sceneFile) return toast('This project has no scene HTML (scene.html) to edit.');
    trim.closeLens(); compare(null);
    const t0 = cutView() ? player.t : renderFile && player.v.readyState > 0 ? player.v.currentTime : player.t;
    editing = true; edSel = null; edHits = [];
    player.v.pause(); player.take.pause();
    player.t = t0;
    player.frame.classList.add('editing');
    player.edit.hidden = false;
    player.pins.hidden = true;
    paintEls(true);
    $('#scEdit', player.el).classList.add('on');
    const under = player.under;
    const src = D.sourceVideo || renderFile;
    if (src) { under.hidden = false; under.src = media(src); under.addEventListener('loadedmetadata', () => { under.currentTime = player.t; }, { once: true }); }
    player.v.hidden = true;
    if (D.kit?.has) {
      frames = new SceneFrames(player.sfHost, { src: sceneSrc(), layers: D.kit.layers, frame: D.frame });
      redraw();
    }
    renderInspector();
  }
  function stopEditing() {
    if (!editing) return;
    editPlay(false);
    editing = false; edSel = null; edHits = [];
    frames?.destroy(); frames = null;
    if (player) {
      player.frame.classList.remove('editing');
      player.edit.hidden = true; player.pins.hidden = false; player.boxes.replaceChildren();
      player.under.hidden = true; player.under.removeAttribute('src'); player.under.load();
      player.v.hidden = false;
      if (renderFile) player.v.currentTime = player.t;
      $('#scEdit', player.el)?.classList.remove('on');
    }
    if (mode === 'scene') ensureSamples();
    paintEls(true);
    renderInspector();
  }

  let drawing = false, again = false;
  async function redraw() {
    if (!frames) return;
    if (drawing) { again = true; return; }
    drawing = true;
    try {
      const res = await frames.draw(player.t, D.overrides, { hidden: hiddenEls() });
      const err = res.find((r) => r.error);
      if (err) toast(`The scene stopped with an error: ${err.error}`);
      edHits = res.flatMap((r) => (r.hits || []).map((k) => ({ ...k, layer: r.layer })));
      const sc = res[0]?.scene;
      if (sc && sc !== sel) { sel = sc; markRows(false); paintTop(); }
      paintBoxes();
      if (!drag && !edPlaying) renderInspector();
    } finally {
      drawing = false;
      if (again) { again = false; redraw(); }
    }
  }

  function paintBoxes() {
    if (!player) return;
    const [W, H] = D.frame;
    player.boxes.replaceChildren(...edHits.map((k) => {
      const on = edSel && k.id === edSel.id;
      const b = h(`<div class="eb${on ? ' on' : ''}${k.id === hoverEl ? ' hover' : ''}${keysOf(k.scene, k.id).length ? ' keyed' : ''}" style="left:${(k.x / W) * 100}%;top:${(k.y / H) * 100}%;width:${(k.w / W) * 100}%;height:${(k.h / H) * 100}%" data-id="${esc(k.id)}">
        <span class="eb-l">${esc(k.label)}</span><i class="eb-h" title="Drag to resize"></i></div>`);
      b.addEventListener('pointerdown', (e) => {
        const r = b.getBoundingClientRect(), corner = r.right - e.clientX < 14 && r.bottom - e.clientY < 14;
        startDrag(e, k, e.target.classList.contains('eb-h') || corner ? 'size' : 'move');
      });
      return b;
    }));
  }

  // The override for an element in the current scope: this scene, or every scene ("*").
  const ovs = () => (D.overrides.scenes ||= {});
  const scopeOf = (k) => (ovs()[k.scene]?.[k.id] ? 'scene' : ovs()['*']?.[k.id] ? 'all' : edScope);
  const keyOf = (k, scope) => (scope === 'all' ? '*' : k.scene);
  function ovOf(k) { const o = ovs()[keyOf(k, scopeOf(k))]?.[k.id]; return { dx: o?.dx || 0, dy: o?.dy || 0, scale: o?.scale || 1, ...(o?.keys?.length ? { keys: o.keys } : {}) }; }
  function setOv(k, ov, scope = scopeOf(k)) {
    const key = keyOf(k, scope);
    ovs()[key] = { ...(ovs()[key] || {}), [k.id]: { ...ov, label: k.label, at: new Date().toISOString() } };
    if (scope === 'all' && ovs()[k.scene]?.[k.id]) delete ovs()[k.scene][k.id];
  }
  // Each element saves on its own (shortly after the last change); moves not saved yet survive a reload of the data.
  function saveOv(k, scope = scopeOf(k)) {
    const key = `${keyOf(k, scope)}/${k.id}`;
    const job = { scene: keyOf(k, scope), el: k.id, ov: ovOf(k), label: k.label };
    pendingOv.set(key, job);
    clearTimeout(saveTimers.get(key));
    saveTimers.set(key, setTimeout(async () => {
      try {
        const doc = await api(`/api/projects/${enc}/overrides`, job);
        if (pendingOv.get(key) === job) pendingOv.delete(key);
        changes++; D.overrides = withPending(doc); preview.key = '';
        paintTop();
      } catch (e) { toast(e.message); }
    }, 150));
  }
  function withPending(doc) {
    doc.scenes ||= {};
    for (const p of pendingOv.values()) doc.scenes[p.scene] = { ...(doc.scenes[p.scene] || {}), [p.el]: { ...p.ov, label: p.label, at: new Date().toISOString() } };
    return doc;
  }
  // ---------- keyframes (◆): the creator's own, in work/overrides.json as the element's keys ----------
  // [{t, dx, dy, s, o, e}] on the render's timeline; the scene kit (kit 2) interpolates them on top of Claude's own
  // animation whenever the scene draws (Edit graphics, renders). keyAt is the kit's maths (core/kit/octopus-scene.js).
  const FR = 30, r3 = (x) => Math.round(x * 1000) / 1000, onFrame = (t) => r3(Math.round(t * FR) / FR), near = (a, b) => Math.abs(a - b) < 0.5 / FR;
  const entryOf = (sid, eid) => D?.overrides?.scenes?.[sid]?.[eid] || D?.overrides?.scenes?.['*']?.[eid] || null;
  const keysOf = (sid, eid) => entryOf(sid, eid)?.keys || [];
  function valueAt(sid, eid, t) {
    const o = entryOf(sid, eid) || {};
    return o.keys?.length ? keyAt(o.keys, t) : { dx: o.dx || 0, dy: o.dy || 0, s: o.scale || 1, o: 1 };
  }
  // Place and size at the playhead: from the keys when there are any, else the element's fixed move.
  function placeOf(k) { const keyed = keysOf(k.scene, k.id).length > 0; if (!keyed) return { ...ovOf(k), keyed }; const v = valueAt(k.scene, k.id, playerTime()); return { dx: v.dx, dy: v.dy, scale: v.s, keyed }; }
  function setPlace(k, patch) {
    if (keysOf(k.scene, k.id).length) return setKeyed(k, playerTime(), { ...(patch.dx != null ? { dx: patch.dx } : {}), ...(patch.dy != null ? { dy: patch.dy } : {}), ...(patch.scale != null ? { s: patch.scale } : {}) });
    setOv(k, { ...ovOf(k), ...patch }); saveOv(k); if (editing) redraw(); else paintEls(true);
  }
  const snapEntry = (slot, eid) => structuredClone(ovs()[slot]?.[eid] || null);
  // Put an element's whole entry back (undo / redo), here and on disk.
  async function putEntry(k, entry, slot = k.scene) {
    const key = `${slot}/${k.id}`;
    pendingOv.delete(key); clearTimeout(saveTimers.get(key));
    if (entry) ovs()[slot] = { ...(ovs()[slot] || {}), [k.id]: entry }; else if (ovs()[slot]) delete ovs()[slot][k.id];
    afterOv();
    const doc = await api(`/api/projects/${enc}/overrides`, { scene: slot, el: k.id, ov: entry ? { dx: entry.dx, dy: entry.dy, scale: entry.scale, keys: entry.keys } : null, label: k.label });
    changes++; D.overrides = withPending(doc); preview.key = ''; afterOv();
  }
  function afterOv() { if (editing) redraw(); paintEls(true); player?.stl.render(); paintTop(); if (!drag && !edPlaying) renderInspector(); }
  // Change an element's keys (they live in this scene's entry: a move for every scene becomes their starting point).
  function keyEdit(k, label, mutate, record = true) {
    const before = snapEntry(k.scene, k.id), base = structuredClone(ovs()[k.scene]?.[k.id] || ovs()['*']?.[k.id] || {});
    const keys = mutate((base.keys || []).map((x) => ({ ...x })), base).filter((x) => Number.isFinite(x.t)).sort((a, b) => a.t - b.t);
    setOv(k, { dx: base.dx || 0, dy: base.dy || 0, scale: base.scale || 1, ...(keys.length ? { keys } : {}) }, 'scene');
    saveOv(k, 'scene');
    if (!keys.length && ovs()[k.scene]?.[k.id] && !base.dx && !base.dy && (base.scale || 1) === 1) delete ovs()[k.scene][k.id];
    afterOv();
    const after = snapEntry(k.scene, k.id);
    if (record) history?.push({ label, undo: () => putEntry(k, before), redo: () => putEntry(k, after) });
  }
  const valuesAt = (keys, base, t) => (keys.length ? keyAt(keys, t) : { dx: base.dx || 0, dy: base.dy || 0, s: base.scale || 1, o: 1 });
  const keyFrom = (t, v) => ({ t, dx: Math.round(v.dx), dy: Math.round(v.dy), s: r3(v.s), o: r3(v.o) });
  async function addKey(k, t = playerTime()) {
    if (!(await ensureKit())) return;
    t = onFrame(t);
    keyEdit(k, `Add a keyframe to ${k.label} at ${c2(t)}`, (keys, base) => {
      const old = keys.find((x) => near(x.t, t));
      return [...keys.filter((x) => !near(x.t, t)), { ...keyFrom(t, valuesAt(keys, base, t)), ...(old?.e ? { e: old.e } : {}) }];
    });
    if (keysOf(k.scene, k.id).length === 1) toast('Keyframe added. Move the playhead, then change the place, size or opacity: Video Octopus adds the next keyframe there.');
  }
  // Change the keyframe at t, or add one there with the values the element has at t.
  async function setKeyed(k, t, patch, record = true) {
    if (!keysOf(k.scene, k.id).length && !(await ensureKit())) return;
    t = onFrame(t);
    keyEdit(k, `Keyframe ${k.label} at ${c2(t)}`, (keys, base) => {
      const i = keys.findIndex((x) => near(x.t, t));
      if (i >= 0) { keys[i] = { ...keys[i], ...patch }; return keys; }
      return [...keys, { ...keyFrom(t, valuesAt(keys, base, t)), ...patch }];
    }, record);
  }
  const elRef = (eid) => ({ id: eid, scene: sel, label: samples.clips.find((c) => c.id === eid)?.label || eid });
  // Several elements in one go, one undo step.
  function keysBatch(label, groups) {
    const refs = [...groups.keys()].map(elRef), before = refs.map((k) => snapEntry(k.scene, k.id));
    for (const k of refs) keyEdit(k, label, groups.get(k.id), false);
    const after = refs.map((k) => snapEntry(k.scene, k.id));
    history?.push({ label, undo: () => Promise.all(refs.map((k, i) => putEntry(k, before[i]))), redo: () => Promise.all(refs.map((k, i) => putEntry(k, after[i]))) });
  }
  const byEl = (list) => { const m = new Map(); for (const x of list) { if (!m.has(x.el)) m.set(x.el, []); m.get(x.el).push(x); } return m; };
  function moveKeys(list) {
    const g = new Map([...byEl(list)].map(([eid, xs]) => [eid, (keys) => {
      const moved = keys.map((k) => { const m = xs.find((x) => near(x.t, k.t)); return m ? { ...k, t: onFrame(Math.max(0, m.to)), moved: true } : k; });
      return moved.filter((k) => k.moved || !moved.some((y) => y.moved && near(y.t, k.t))).map(({ moved: _, ...k }) => k);
    }]));
    keysBatch(list.length > 1 ? `Move ${list.length} keyframes` : 'Move a keyframe', g);
  }
  function removeKeys(list) {
    const g = new Map([...byEl(list)].map(([eid, xs]) => [eid, (keys) => keys.filter((k) => !xs.some((x) => near(x.t, k.t)))]));
    keysBatch(list.length > 1 ? `Delete ${list.length} keyframes` : 'Delete a keyframe', g);
  }
  // Copies land at the playhead (several keep their spacing).
  function duplicateKeys(list) {
    const t0 = Math.min(...list.map((x) => x.t)), at = playerTime();
    const g = new Map([...byEl(list)].map(([eid, xs]) => [eid, (keys) => {
      const copies = xs.map((x) => keys.find((k) => near(k.t, x.t))).filter(Boolean).map((k) => ({ ...k, t: onFrame(at + (k.t - t0)) }));
      return [...keys.filter((k) => !copies.some((c) => near(c.t, k.t))), ...copies];
    }]));
    keysBatch(list.length > 1 ? `Copy ${list.length} keyframes to the playhead` : 'Copy a keyframe to the playhead', g);
  }
  function setEase(k, t, e) { keyEdit(k, `Keyframe ${k.label}: ${e || 'ease'} to the next`, (keys) => keys.map((x) => (near(x.t, t) ? { ...x, e: e || undefined } : x))); }
  function jumpKey(k, dir) {
    const t = playerTime(), ks = keysOf(k.scene, k.id).map((x) => x.t);
    const to = dir > 0 ? ks.find((x) => x > t + 0.5 / FR) : [...ks].reverse().find((x) => x < t - 0.5 / FR);
    if (to != null) seekTo(to); else toast(dir > 0 ? 'No keyframe after the playhead.' : 'No keyframe before the playhead.');
  }
  // Keys and markers need kit 2 in the project (assets/octopus-scene.js). Updating only adds them.
  async function ensureKit(user, newest) {
    if (!D.kit?.has) { toast('This scene doesn\'t load the Video Octopus scene kit yet: ask Claude to make its graphics movable first.'); return false; }
    if (!kitOld() && !(newest && kitBehind())) { if (user) toast('The scene kit is up to date.'); return true; }
    try {
      await api(`/api/projects/${enc}/kit-update`, {});
      D.kit.version = D.kit.latest; kitBust = Date.now();
      toast(newest ? 'Updated this project\'s scene kit (assets/octopus-scene.js): the timeline now shows elements under their parent, and text gets the type bar. Nothing else changes.' : 'Updated this project\'s scene kit (assets/octopus-scene.js) so keyframes and motion markers work. Nothing else changes.');
      probe?.destroy(); probe?.host?.remove(); probe = null; sampleJob++; samples = { key: '', state: 'none', times: [], hits: [], clips: [] };
      if (editing && frames) { frames.destroy(); frames = new SceneFrames(player.sfHost, { src: sceneSrc(), layers: D.kit.layers, frame: D.frame }); redraw(); }
      if (mode === 'scene') ensureSamples();
      return true;
    } catch (e) { toast(e.message); return false; }
  }
  // The Keyframes section of the element panel and of Edit graphics.
  function keysHtml(k) {
    if (!D.kit?.has) return '';
    if (kitOld()) return `<section class="kf"><h3>Keyframes</h3><p class="sub">Keyframes need the newer Video Octopus scene kit in this project. Updating only adds keyframes and motion markers; nothing else changes.</p><button class="btn wide" data-a="kitup">Update the scene kit</button></section>`;
    const ks = keysOf(k.scene, k.id), t = onFrame(playerTime()), v = valueAt(k.scene, k.id, t), at = ks.find((x) => near(x.t, t));
    const val = (x) => `${x.dx >= 0 ? '+' : '−'}${Math.abs(x.dx)}, ${x.dy >= 0 ? '+' : '−'}${Math.abs(x.dy)} · ${Math.round((x.s ?? 1) * 100)}% · ${Math.round((x.o ?? 1) * 100)}%`;
    return `<section class="kf"><h3>Keyframes${ks.length ? ` <span class="sub">${ks.length}</span>` : ''}</h3>
      ${ks.length ? `<div class="kf-list">${ks.map((x, i) => `<div class="kf-row${near(x.t, t) ? ' on' : ''}"><button class="kf-go" data-go="${x.t}" title="Go to this keyframe">◆ <span class="mono">${c2(x.t)}</span></button>
        <span class="kf-v mono" title="x, y (px) · size · opacity">${val(x)}</span>
        ${i < ks.length - 1 ? `<select class="field kf-e" data-e="${x.t}" aria-label="How it gets to the next keyframe"><option value="">Ease</option><option value="linear"${x.e === 'linear' ? ' selected' : ''}>Linear</option><option value="hold"${x.e === 'hold' ? ' selected' : ''}>Hold</option></select>` : '<span></span>'}
        <button class="btn ghost small" data-del="${x.t}" aria-label="Delete the keyframe at ${c2(x.t)}">✕</button></div>`).join('')}</div>`
        : '<p class="sub">Add a keyframe, move the playhead, then change the place, size or opacity: Video Octopus adds the next keyframe and plays the move on top of Claude\'s animation.</p>'}
      <label class="slider"><span>Opacity</span><input type="range" id="kfO" min="0" max="1" step="0.01" value="${r3(v.o)}"><span class="val">${Math.round(v.o * 100)}%</span></label>
      <div class="kf-btns"><button class="btn" data-a="kprev" aria-label="Previous keyframe" title="Previous keyframe">◀</button><button class="btn${at ? '' : ' dark'} kf-add" data-a="kadd">${at ? `◆ On a keyframe · ${c2(t)}` : `◆ Add keyframe at ${c2(t)}`}</button><button class="btn" data-a="knext" aria-label="Next keyframe" title="Next keyframe">▶</button></div>
      <p class="sub">Keyframes save straight away, play in Edit graphics and on the scene timeline (◆), and every render bakes them in. Claude sees them in the change package.</p></section>`;
  }
  function wireKeys(box, k) {
    box.querySelector('[data-a=kitup]')?.addEventListener('click', async () => { await ensureKit(true); renderInspector(); });
    box.querySelectorAll('[data-go]').forEach((b) => (b.onclick = () => seekTo(Number(b.dataset.go))));
    box.querySelectorAll('[data-del]').forEach((b) => (b.onclick = () => removeKeys([{ el: k.id, t: Number(b.dataset.del) }])));
    box.querySelectorAll('[data-e]').forEach((x) => (x.onchange = () => setEase(k, Number(x.dataset.e), x.value || null)));
    const o = box.querySelector('#kfO');
    if (o) { o.oninput = () => { o.nextElementSibling.textContent = `${Math.round(o.value * 100)}%`; }; o.onchange = () => setKeyed(k, playerTime(), { o: Number(o.value) }); }
    box.querySelector('[data-a=kadd]')?.addEventListener('click', () => addKey(k));
    box.querySelector('[data-a=kprev]')?.addEventListener('click', () => jumpKey(k, -1));
    box.querySelector('[data-a=knext]')?.addEventListener('click', () => jumpKey(k, 1));
  }
  // The panel follows the playhead while paused: the add button's time, the opacity and place at that moment.
  let kfAt = null;
  function refreshKeysUI() {
    const add = inspector.querySelector('[data-a=kadd]');
    if (!add || isPlaying()) return;
    const t = onFrame(playerTime());
    if (t === kfAt) return;
    kfAt = t;
    const id = editing ? edSel?.id : elSel;
    if (!id) return;
    const k = { id, scene: sel }, ks = keysOf(sel, id), at = ks.find((x) => near(x.t, t)), v = valueAt(sel, id, t);
    add.textContent = at ? `◆ On a keyframe · ${c2(t)}` : `◆ Add keyframe at ${c2(t)}`;
    add.classList.toggle('dark', !at);
    const o = inspector.querySelector('#kfO');
    if (o && document.activeElement !== o) { o.value = r3(v.o); o.nextElementSibling.textContent = `${Math.round(v.o * 100)}%`; }
    inspector.querySelectorAll('.kf-row').forEach((r) => r.classList.toggle('on', Number(r.querySelector('[data-go]')?.dataset.go) === at?.t));
    if (ks.length) {
      const p = placeOf(k);
      for (const [sel2, val] of [['#elX', p.dx], ['#elY', p.dy], ['#edX', p.dx], ['#edY', p.dy]]) { const f = inspector.querySelector(sel2); if (f && document.activeElement !== f) f.value = Math.round(val); }
    }
  }

  async function moveScope(k, to) {
    const sc = scopeOf(k);
    if (to === sc) return;
    const ov = ovOf(k);
    try {
      pendingOv.delete(`${keyOf(k, sc)}/${k.id}`);
      await api(`/api/projects/${enc}/overrides`, { scene: keyOf(k, sc), el: k.id, ov: null });
      const doc = await api(`/api/projects/${enc}/overrides`, { scene: keyOf(k, to), el: k.id, ov, label: k.label });
      changes++; D.overrides = withPending(doc);
      edScope = to; if (editing) redraw(); renderInspector();
    } catch (e) { toast(e.message); }
  }

  let drag = null;
  // Drag a box: an element with keyframes gets a keyframe at the playhead (changed if there's one there, added if not);
  // one without moves as a whole. Either way ⌘Z puts it back.
  function startDrag(e, k, kind) {
    e.preventDefault(); e.stopPropagation();
    if (edPlaying) editPlay(false);
    edSel = { id: k.id, scene: k.scene, label: k.label };
    const r = player.boxes.getBoundingClientRect(), [W] = D.frame, px = W / r.width;
    const keyed = keysOf(k.scene, k.id).length > 0, slot = keyed ? k.scene : keyOf(k, scopeOf(k));
    const ov0 = keyed ? placeOf(k) : ovOf(k), before = snapEntry(slot, k.id);
    const box = edHits.find((x) => x.id === k.id) || k;
    const cx = r.left + ((box.x + box.w / 2) / W) * r.width;
    drag = { k, kind, x0: e.clientX, y0: e.clientY, ov0, px, cx, half: Math.max(8, e.clientX - cx), keyed, moved: false };
    const move = (ev) => {
      const o = { ...drag.ov0 };
      if (drag.kind === 'move') { o.dx = Math.round(drag.ov0.dx + (ev.clientX - drag.x0) * drag.px); o.dy = Math.round(drag.ov0.dy + (ev.clientY - drag.y0) * drag.px); }
      else o.scale = Math.round(Math.min(8, Math.max(0.1, drag.ov0.scale * ((ev.clientX - drag.cx) / drag.half))) * 1000) / 1000;
      drag.moved = true;
      if (drag.keyed) setKeyed(drag.k, player.t, { dx: o.dx, dy: o.dy, s: o.scale }, false);
      else setOv(drag.k, o);
      redraw();
    };
    const up = () => {
      removeEventListener('pointermove', move); removeEventListener('pointerup', up);
      const d = drag; drag = null;
      if (d.moved) {
        if (!d.keyed) saveOv(d.k);
        const after = snapEntry(slot, d.k.id);
        history?.push({ label: d.keyed ? `Keyframe ${d.k.label} at ${c2(player.t)}` : `${d.kind === 'move' ? 'Move' : 'Resize'} ${d.k.label}`, undo: () => putEntry(d.k, before, slot), redo: () => putEntry(d.k, after, slot) });
      }
      renderInspector();
    };
    addEventListener('pointermove', move);
    addEventListener('pointerup', up);
    paintBoxes();
    renderInspector();
  }

  function renderEditor() {
    const s = scene(sel);
    const k = edSel && edHits.find((x) => x.id === edSel.id);
    const box = h(`<div class="ins-body sc-ins">
      <div class="ins-head"><span class="sel-dot"></span><b>Graphics</b><span class="sub">scene ${s.n} · ${clock(player?.t || 0)}</span><span class="gap"></span><button class="btn small dark" id="edDone">Done</button></div>
      ${!D.kit?.has ? `<section><h3>Not movable yet</h3><p class="sub">${esc(D.sceneFile)} doesn't load the Video Octopus scene kit, so its titles and cards can't be picked here yet. Claude can wire it up without changing how anything looks.</p>
        <button class="btn wide" id="edKit">${ICON.claude}Ask Claude to make them movable</button></section>` : `
      <section><h3>At this moment</h3><div class="eb-list" id="edList">${edHits.length ? '' : '<p class="sub">Nothing movable is on screen here. Scrub the timeline to a moment with a title or card.</p>'}</div></section>
      ${k ? `<section id="edSel"><h3>${esc(k.label)}</h3>
        <div class="ed-grid"><label>X<input class="field num" type="number" id="edX" step="1" value="${Math.round(placeOf(k).dx)}"></label><label>Y<input class="field num" type="number" id="edY" step="1" value="${Math.round(placeOf(k).dy)}"></label></div>
        <label class="slider"><span>Size</span><input type="range" id="edS" min="0.2" max="3" step="0.01" value="${placeOf(k).scale}"><span class="val">${Math.round(placeOf(k).scale * 100)}%</span></label>
        ${keysOf(k.scene, k.id).length ? `<p class="sub">Keyframed: place and size change the keyframe at the playhead (or add one there).</p>` : `<div class="row"><span>Applies to</span><div class="seg" id="edScope" role="group" aria-label="Which scenes"><button data-s="scene">Scene ${esc(k.scene)}</button><button data-s="all">Every scene</button></div></div>`}
        <button class="btn wide" id="edReset">Back to where it was</button></section>
        ${keysHtml({ id: k.id, scene: k.scene, label: k.label })}` : ''}`}
      <p class="sub hint">Drag a box to move it and its corner to resize it; arrow keys nudge (⇧ 10 px). Moves show straight away (the scene kit applies them whenever the scene draws) and wait in the change package so the next render bakes them in.</p></div>`);
    inspector.replaceChildren(box);
    $('#edDone', box).onclick = () => stopEditing();
    $('#edKit', box)?.addEventListener('click', async () => { await askKit(); stopEditing(); });
    const lst = $('#edList', box);
    if (lst) for (const x of edHits) {
      const b = h(`<button class="layer${edSel && x.id === edSel.id ? ' on' : ''}"><span class="lk el" aria-hidden="true"></span><span class="ln"><b>${esc(x.label)}</b><small>${esc(x.id)}${x.layer ? ` · ${esc(x.layer)} layer` : ''}${Object.values(ovOf(x)).some((v, i) => (i < 2 ? v : v !== 1)) ? ' · moved' : ''}</small></span></button>`);
      b.onclick = () => { edSel = { id: x.id, scene: x.scene, label: x.label }; paintBoxes(); renderInspector(); };
      lst.append(b);
    }
    if (!k) return;
    const kk = { id: k.id, scene: k.scene, label: k.label };
    $('#edX', box).onchange = (e) => setPlace(kk, { dx: Math.round(Number(e.target.value) || 0) });
    $('#edY', box).onchange = (e) => setPlace(kk, { dy: Math.round(Number(e.target.value) || 0) });
    $('#edS', box).oninput = (e) => {
      $('.val', e.target.parentElement).textContent = `${Math.round(Number(e.target.value) * 100)}%`;
      if (!keysOf(k.scene, k.id).length) { setOv(k, { ...ovOf(k), scale: Number(e.target.value) }); redraw(); }
    };
    $('#edS', box).onchange = (e) => setPlace(kk, { scale: Number(e.target.value) });
    const sc = scopeOf(k);
    box.querySelectorAll('#edScope button').forEach((b) => {
      b.classList.toggle('on', b.dataset.s === sc); b.setAttribute('aria-pressed', String(b.dataset.s === sc));
      b.onclick = () => moveScope(k, b.dataset.s);
    });
    $('#edReset', box).onclick = async () => {
      const key = keysOf(k.scene, k.id).length ? k.scene : keyOf(k, sc), before = snapEntry(key, k.id);
      await putEntry(kk, null, key);
      history?.push({ label: `Put ${k.label} back`, undo: () => putEntry(kk, before, key), redo: () => putEntry(kk, null, key) });
    };
    wireKeys(box, kk);
  }

  // Keys: Space play · ↑ ↓ scene · N note · A approve · E edit graphics · C compare (tap: the before/after line, hold:
  // the version before full) · Esc back.
  function onKey(e) {
    if (!active || /TEXTAREA|INPUT|SELECT/.test(document.activeElement.tagName) || !$('#modal').hidden || e.metaKey || e.ctrlKey || e.altKey) return;
    if (editing && e.key === 'Escape') { stopEditing(); return; }
    if (editing && edSel && e.key.startsWith('Arrow')) {
      const k = edHits.find((x) => x.id === edSel.id);
      if (!k) return;
      e.preventDefault();
      const stp = e.shiftKey ? 10 : 1, o = placeOf(k), d = { dx: 0, dy: 0 };
      if (e.key === 'ArrowLeft') d.dx = -stp; if (e.key === 'ArrowRight') d.dx = stp;
      if (e.key === 'ArrowUp') d.dy = -stp; if (e.key === 'ArrowDown') d.dy = stp;
      setPlace({ id: k.id, scene: k.scene, label: k.label }, { dx: Math.round(o.dx + d.dx), dy: Math.round(o.dy + d.dy) });
      return;
    }
    if (e.code === 'Space') { e.preventDefault(); togglePlay(); return; }
    if (!D?.ready) return;
    if (e.key === 'ArrowUp') { e.preventDefault(); step(-1); }
    else if (e.key === 'ArrowDown') { e.preventDefault(); step(1); }
    else if (e.key === 'n' || e.key === 'N') { e.preventDefault(); pauseAll(); setTab('notes'); focusComposer(); }
    else if (e.key === 'a' || e.key === 'A') { e.preventDefault(); approve(); }
    else if (e.key === 'e' || e.key === 'E') { e.preventDefault(); editing ? stopEditing() : startEditing(); }
    else if ((e.key === 'c' || e.key === 'C') && !editing) {
      e.preventDefault();
      if (e.repeat) return;
      if (!prevRender()) { toast('There is no earlier render to compare with.'); return; }
      cmpDown = performance.now(); cmpHeld = !cmp?.mode();
      if (cmpHeld) compare('full');
    }
    else if (e.key === 'Escape' && cmp?.mode()) compare(null);
    else if (e.key === 'Escape' && elSel) { elSel = null; setTab('look'); }
  }
  function onKeyUp(e) {
    if (!active || (e.key !== 'c' && e.key !== 'C') || !cmpDown) return;
    const short = performance.now() - cmpDown < 300;
    cmpDown = 0;
    if (cmpHeld) compare(short ? 'split' : null); else if (short) compare(null);
    cmpHeld = false;
  }
  document.addEventListener('keydown', onKey);
  document.addEventListener('keyup', onKeyUp);

  // The bar between the picture and the timeline. Down folds the timeline to its top lanes (words and voice in One
  // scene; sections and scenes in Whole video) so the picture gets bigger; up shows every lane, as far as the picture
  // keeps 200 px. Remembered per view: 'fold', 'max' or a height in px.
  function tlBox() {
    const full = mode === 'full', host = full ? $('#scTl', player.el) : $('#scStl', player.el);
    if (!host || host.closest('[hidden]') || host.hidden) return null;
    const m = (full ? player.tl : player.stl).metrics();
    if (!m.lanes.length) return null;
    if (m.sub) miniH = m.sub;
    const notice = full ? null : $('.stl-notice', host), nh = notice && !notice.hidden ? notice.offsetHeight : 0;
    const upTo = (n) => m.lanes.slice(0, n).reduce((a, r) => a + r.h, 0) + 2;
    const stop = m.lanes.findIndex((r) => r.k === (full ? 'scenes' : 'voice'));
    const fixed = m.head + nh + 2;
    const all = fixed + (full ? 0 : miniH) + upTo(m.lanes.length);
    return { fold: Math.min(all, fixed + upTo(stop >= 0 ? stop + 1 : Math.min(3, m.lanes.length))), all };
  }
  function fitTl() {
    if (!player) return null;
    const b = tlBox(); if (!b) return null;
    const el = player.el, main = $('.s2-main', el);
    const room = main.clientHeight - $('.s2-top', el).offsetHeight - $('.transport', el).offsetHeight - $('#s2Split', el).offsetHeight - 14 - 200;
    const max = Math.max(b.fold, Math.min(b.all, room)), want = tlh[mode];
    const hpx = Math.round(want === 'fold' ? b.fold : want === 'max' ? max : Math.max(b.fold, Math.min(max, +want || max)));
    main.style.setProperty('--tlh', `${hpx}px`);
    el.classList.toggle('tl-folded', hpx <= b.fold + 1 && b.fold < b.all);
    const sp = $('#s2Split', el);
    sp.setAttribute('aria-valuemin', Math.round(b.fold)); sp.setAttribute('aria-valuemax', Math.round(max)); sp.setAttribute('aria-valuenow', hpx);
    return { b, max, hpx };
  }
  function setTlh(v, save = true) {
    if (v !== 'fold') lastOpen[mode] = v;
    tlh[mode] = v; fitTl();
    if (save) LS(`studio.scenes.tlh.${mode}`, v);
  }
  function splitDrag(e) {
    if (e.button !== 0) return;
    const sp = e.currentTarget, f0 = fitTl(); if (!f0) return;
    e.preventDefault();
    const y0 = e.clientY;
    sp.classList.add('drag'); document.body.classList.add('rs-ns');
    try { sp.setPointerCapture(e.pointerId); } catch {}
    const mv = (ev) => {
      const hh = f0.hpx + (y0 - ev.clientY);
      setTlh(hh <= f0.b.fold + 28 ? 'fold' : hh >= f0.max - 12 ? 'max' : String(Math.round(hh)), false);
    };
    const up = () => {
      sp.classList.remove('drag'); document.body.classList.remove('rs-ns');
      sp.removeEventListener('pointermove', mv); sp.removeEventListener('pointerup', up); sp.removeEventListener('pointercancel', up);
      LS(`studio.scenes.tlh.${mode}`, tlh[mode]);
    };
    sp.addEventListener('pointermove', mv); sp.addEventListener('pointerup', up); sp.addEventListener('pointercancel', up);
  }

  function teardownMedia() {
    cancelAnimationFrame(raf);
    trim.closeLens(); cmp?.destroy(); cmp = null;
    if (player) { player.take.pause(); player.take.removeAttribute('src'); player.take2.removeAttribute('src'); }
    if (editing) { edPlaying = false; cancelAnimationFrame(edRaf); editing = false; frames?.destroy(); frames = null; }
    if (player) { player.v.pause(); player.v.removeAttribute('src'); player.v.load(); player.under.removeAttribute('src'); player.tl?.destroy(); player.stl?.destroy(); player.ro?.disconnect(); player = null; }
    thumbJob++; sampleJob++;
  }

  return {
    update, load,
    data: () => D,
    show: async () => { active = true; built = ''; if ((await load()) && active && D) build(); },
    hide: () => { active = false; player?.v.pause(); player?.take.pause(); trim.closeLens(); if (editing) stopEditing(); },
    selectScene: (sid) => select(sid),
    showPlan,
    apply: applyNotes,
    destroy: () => { active = false; teardownMedia(); probe?.destroy(); probe?.host?.remove(); trim.destroy(); document.removeEventListener('keydown', onKey); document.removeEventListener('keyup', onKeyUp); },
  };
}
