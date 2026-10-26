// Simple mode's editable waveform and transcript (V1 spec §6, one-editor §0.2): the take's waveform at the bottom of
// the editor with the cut on it (kept parts bright, cut parts greyed), play and time, drag across to select, Cut, Split,
// Undo, the two end handles to trim the start and end, and a click on a greyed part to bring it back. The transcript
// above it crosses out the cut words; a click on a word cuts it or brings it back.
//
// Every edit writes the one cut the pipeline reads: work/edl_manual.json through POST /cut-save (the route Scenes and
// the Cut Editor's saves use: server/cutsync.mjs saveCut, markEdits counts it as the creator's decision). The B3 rule
// holds: once Lock the cut has run, the route refuses (409 locked) and the waveform says "The cut is locked" with
// Unlock to edit (POST /cut-review { op: 'unlock' }, the Cut tab's own Unlock), after which Lock is the next step again.
//
// The cut operations are pure and exported for the tests; segments are [[start, end], …] in take seconds.
import { esc, h, api, toast } from './ui.js';

export const r3 = (x) => Math.round(x * 1000) / 1000;
const MIN = 0.02;
export const lengthOf = (segs) => segs.reduce((t, [a, b]) => t + Math.max(0, b - a), 0);
// Sorted, overlaps merged (touching parts stay apart: a Split), slivers dropped.
export function normSegs(segs) {
  const s = (segs || []).map(([a, b]) => [Number(a), Number(b)]).filter(([a, b]) => Number.isFinite(a) && Number.isFinite(b) && b - a > MIN).sort((x, y) => x[0] - y[0]);
  const out = [];
  for (const [a, b] of s) {
    const last = out[out.length - 1];
    if (last && a < last[1] - 1e-3) last[1] = Math.max(last[1], b); else out.push([a, b]);
  }
  return out.map(([a, b]) => [r3(a), r3(b)]);
}
// Cut [a, b] out of the kept parts.
export function cutRange(segs, a, b) {
  const lo = Math.min(a, b), hi = Math.max(a, b);
  return normSegs(segs.flatMap(([x, y]) => (hi <= x || lo >= y ? [[x, y]] : [[x, Math.min(y, lo)], [Math.max(x, hi), y]])));
}
// Bring [a, b] back: kept again, joined to the kept parts it touches.
export function restoreRange(segs, a, b) {
  const lo = Math.min(a, b), hi = Math.max(a, b);
  const touching = segs.filter(([x, y]) => y >= lo - 1e-3 && x <= hi + 1e-3);
  const rest = segs.filter((s) => !touching.includes(s));
  const merged = [Math.min(lo, ...touching.map((s) => s[0])), Math.max(hi, ...touching.map((s) => s[1]))];
  return normSegs([...rest, merged]);
}
// Split the kept part under t in two (nothing changes in the video; a join point to cut at or trim to).
export function splitAt(segs, t) {
  const i = segs.findIndex(([a, b]) => t > a + 0.05 && t < b - 0.05);
  if (i < 0) return segs;
  const [a, b] = segs[i];
  return [...segs.slice(0, i), [a, r3(t)], [r3(t), b], ...segs.slice(i + 1)];
}
// The two end handles: the video starts at t (what's before goes; an earlier t brings the start back) / ends at t.
export function trimStart(segs, t) {
  if (!segs.length) return segs;
  if (t < segs[0][0]) return normSegs([[t, segs[0][1]], ...segs.slice(1)]);
  return normSegs(segs.filter(([, b]) => b > t + MIN).map(([a, b]) => [Math.max(a, t), b]));
}
export function trimEnd(segs, t) {
  if (!segs.length) return segs;
  const last = segs[segs.length - 1];
  if (t > last[1]) return normSegs([...segs.slice(0, -1), [last[0], t]]);
  return normSegs(segs.filter(([a]) => a < t - MIN).map(([a, b]) => [a, Math.min(b, t)]));
}
// The greyed parts: what the cut leaves out of the take, start and end included.
export function gapsOf(segs, duration) {
  const out = [];
  let t = 0;
  for (const [a, b] of segs) { if (a - t > MIN) out.push([r3(t), r3(a)]); t = Math.max(t, b); }
  if (duration && duration - t > MIN) out.push([r3(t), r3(duration)]);
  return out;
}
// Take time ↔ the cut's own time (what the video plays: kept parts end to end).
export function takeToCut(segs, t) {
  let d = 0;
  for (const [a, b] of segs) { if (t < a) return d; if (t <= b) return d + (t - a); d += b - a; }
  return d;
}
export const isKept = (segs, t) => segs.some(([a, b]) => t >= a && t < b);
// A word is cut when its middle is outside the kept parts.
export const wordCut = (segs, w) => !isKept(segs, (w[0] + w[1]) / 2);

// ---- the cut, shared by the waveform and the transcript ----
// load(): the take, its words and the cut (GET /cut-take); edit(segs): saves through /cut-save with an undo stack.
export function makeCutModel({ id, onChange = () => {}, onUnlock = () => {} }) {
  const base = `/api/projects/${encodeURIComponent(id)}`;
  const m = { ready: false, why: '', video: null, words: [], segs: [], version: null, duration: 0, locked: false, undo: [], busy: false, sel: null };
  m.load = async () => {
    let r = null;
    try { r = await api(`${base}/cut-take`); } catch { r = null; }
    if (r?.ok) Object.assign(m, { ready: true, why: '', video: r.video, words: r.words || [], segs: normSegs(r.segments), version: r.version, duration: r.duration || 0 });
    else Object.assign(m, { ready: false, why: r?.why || '', words: [], segs: [], version: null });
    onChange(m);
    return m;
  };
  async function save(segs, { undoable = true } = {}) {
    if (!m.ready || m.busy) return false;
    const next = normSegs(segs);
    if (!next.length) { toast('Keep at least a little of the take.'); return false; }
    if (JSON.stringify(next) === JSON.stringify(m.segs)) return false;
    m.busy = true;
    const before = m.segs;
    m.segs = next; onChange(m); // drawn at once; put back if the save is refused
    try {
      const r = await api(`${base}/cut-save`, { segments: next, version: m.version });
      if (r.locked) { m.segs = before; m.locked = true; onChange(m); return false; }
      if (r.conflict) { toast('The cut changed meanwhile (Claude or another window). Here it is as it is now.'); m.busy = false; await m.load(); return false; }
      if (r.ok === false) throw new Error(r.error || 'The cut wasn’t saved.');
      m.version = r.version; m.locked = false;
      if (undoable) { m.undo.push(before); if (m.undo.length > 50) m.undo.shift(); }
      return true;
    } catch (e) { m.segs = before; toast(e.message); return false; }
    finally { m.busy = false; onChange(m); }
  }
  m.edit = (segs) => save(segs);
  m.undoLast = async () => { const prev = m.undo.pop(); if (!prev) return toast('Nothing to undo here.'); await save(prev, { undoable: false }); };
  m.unlock = async () => { try { await api(`${base}/cut-review`, { op: 'unlock' }); m.locked = false; toast('Unlocked. Lock the cut runs again after your edits.'); onChange(m); onUnlock(); } catch (e) { toast(e.message); } };
  return m;
}

// ---- the waveform ----
// host: where it goes; model: makeCutModel; player: { play(), pause(), playing(), time(), seek(t) } (take seconds);
// peaksUrl(file): the take's peaks; blocks(): [{ a, b, label, state }] scene or section blocks in take seconds.
export function makeWave({ host, model, player, peaksUrl, blocks = () => [], fallbackFile = () => null, onSelect = () => {} }) {
  const el = h(`<section class="sw-wave" aria-label="Waveform">
    <div class="sw-top">
      <button type="button" class="sw-play" aria-label="Play"><i></i></button>
      <span class="sw-time" aria-live="off">0:00 / 0:00</span>
      <span class="sw-sel" hidden></span>
      <span class="gap"></span>
      <span class="sw-lock" hidden><span>The cut is locked.</span><button type="button" class="btn small" data-a="unlock">Unlock to edit</button></span>
      <span class="sw-tools" role="group" aria-label="Edit the cut">
        <button type="button" class="btn small" data-a="cut" disabled title="Cut the selected part out (Delete)">Cut</button>
        <button type="button" class="btn small" data-a="split" title="Split the part under the playhead (S)">Split</button>
        <button type="button" class="btn small" data-a="undo" title="Undo the last edit here (⌘Z)">Undo</button>
      </span>
    </div>
    <div class="sw-lanes"><div class="sw-blocks" aria-hidden="true"></div>
      <div class="sw-cv-wrap"><canvas class="sw-cv" role="img" aria-label="The take's waveform: bright parts play, greyed parts are cut"></canvas>
        <button type="button" class="sw-h start" aria-label="Trim the start: drag"></button><button type="button" class="sw-h end" aria-label="Trim the end: drag"></button></div></div>
    <p class="sw-hint">Drag the ends to trim · drag across to select · Cut removes it · click a greyed part to bring it back · or just tell Claude.</p>
  </section>`);
  host.append(el);
  const cv = el.querySelector('.sw-cv'), wrap = el.querySelector('.sw-cv-wrap');
  let peaks = null, peaksFile = null, drag = null, raf = 0, alive = true;
  const dur = () => model.duration || player.duration?.() || 0;
  const xOf = (t) => (dur() ? (t / dur()) * wrap.clientWidth : 0);
  const tOf = (x) => Math.max(0, Math.min(dur(), (x / Math.max(1, wrap.clientWidth)) * dur()));
  async function loadPeaks() {
    const f = model.video || fallbackFile();
    if (!f || f === peaksFile) return;
    peaksFile = f;
    try { const r = await fetch(peaksUrl(f)); peaks = await r.json(); } catch { peaks = null; }
    draw();
  }
  function draw() {
    const d = devicePixelRatio || 1, w = Math.round(wrap.clientWidth * d), hh = Math.round(wrap.clientHeight * d);
    if (!w || !hh) return;
    if (cv.width !== w || cv.height !== hh) { cv.width = w; cv.height = hh; }
    const g = cv.getContext('2d'), css = getComputedStyle(el);
    const keep = css.getPropertyValue('--sw-keep').trim() || 'gray', gone = css.getPropertyValue('--sw-gone').trim() || 'gray';
    const selC = css.getPropertyValue('--sw-sel').trim() || 'blue', head = css.getPropertyValue('--sw-head').trim() || 'red';
    g.clearRect(0, 0, w, hh);
    const data = peaks?.data || [], top = (peaks && (peaks.top ??= data.reduce((mx, v) => (v > mx ? v : mx), 1))) || 1;
    const segs = model.ready ? model.segs : [[0, dur()]];
    const bar = 3 * d, n = Math.max(1, Math.floor(w / bar));
    for (let i = 0; i < n; i++) {
      const a = Math.floor((i / n) * data.length), b = Math.max(a + 1, Math.floor(((i + 1) / n) * data.length));
      let mx = 0; for (let k = a; k < b && k < data.length; k++) mx = Math.max(mx, data[k]);
      const bh = Math.max(2 * d, (data.length ? mx / top : 0.06) * (hh - 8 * d));
      const t = ((i + 0.5) / n) * dur();
      g.fillStyle = isKept(segs, t) ? keep : gone;
      g.fillRect(i * bar, (hh - bh) / 2, Math.max(1, bar - d), bh);
    }
    // cut parts: a wash over them
    g.fillStyle = css.getPropertyValue('--sw-wash').trim() || 'rgba(0,0,0,.1)';
    if (model.ready) for (const [a, b] of gapsOf(model.segs, dur())) g.fillRect(xOf(a) * d, 0, (xOf(b) - xOf(a)) * d, hh);
    if (model.sel) { const [a, b] = model.sel; g.fillStyle = selC; g.globalAlpha = 0.22; g.fillRect(xOf(Math.min(a, b)) * d, 0, Math.abs(xOf(b) - xOf(a)) * d, hh); g.globalAlpha = 1; }
    const t = player.time();
    g.fillStyle = head; g.fillRect(xOf(t) * d - d, 0, 2 * d, hh);
    // the end handles sit on the first kept start and the last kept end
    const hs = el.querySelector('.sw-h.start'), he = el.querySelector('.sw-h.end');
    const on = model.ready && model.segs.length && !model.locked;
    hs.hidden = he.hidden = !on;
    if (on) { hs.style.left = `${xOf(model.segs[0][0])}px`; he.style.left = `${xOf(model.segs.at(-1)[1])}px`; }
  }
  function paintBlocks() {
    const lane = el.querySelector('.sw-blocks'), list = blocks();
    lane.hidden = !list.length;
    lane.replaceChildren(...list.map((b) => {
      const x = h(`<span class="sw-blk ${esc(b.state || '')}" title="${esc(b.label)}">${b.state === 'built' ? '✓ ' : ''}${esc(b.label)}</span>`);
      x.style.left = `${(b.a / Math.max(1e-6, dur())) * 100}%`; x.style.width = `${(Math.max(0, b.b - b.a) / Math.max(1e-6, dur())) * 100}%`;
      return x;
    }));
  }
  const fmt = (s) => { const t = Math.max(0, s || 0); return `${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, '0')}`; };
  function paintTop() {
    const t = player.time(), segs = model.ready ? model.segs : null;
    el.querySelector('.sw-time').textContent = segs ? `${fmt(takeToCut(segs, t))} / ${fmt(lengthOf(segs))}` : `${fmt(t)} / ${fmt(dur())}`;
    el.querySelector('.sw-play').classList.toggle('on', player.playing());
    el.querySelector('.sw-play').setAttribute('aria-label', player.playing() ? 'Pause' : 'Play');
    const sel = model.sel && Math.abs(model.sel[1] - model.sel[0]) > 0.05 ? [Math.min(...model.sel), Math.max(...model.sel)] : null;
    const s = el.querySelector('.sw-sel');
    s.hidden = !sel;
    if (sel) s.textContent = `Selected ${fmt(segs ? takeToCut(segs, sel[0]) : sel[0])}–${fmt(segs ? takeToCut(segs, sel[1]) : sel[1])}`;
    const edit = model.ready && !model.locked;
    el.querySelector('[data-a=cut]').disabled = !edit || !sel;
    el.querySelector('[data-a=split]').disabled = !edit;
    el.querySelector('[data-a=undo]').disabled = !edit || !model.undo.length;
    el.querySelector('.sw-lock').hidden = !model.locked;
    el.classList.toggle('readonly', !model.ready);
    el.querySelector('.sw-hint').textContent = model.locked ? 'The cut is locked after the rough cut. Unlock to edit, or just tell Claude.'
      : model.ready ? 'Drag the ends to trim · drag across to select · Cut removes it · click a greyed part to bring it back · or just tell Claude.'
        : 'Editing on the waveform opens after the rough cut. Or just tell Claude.';
  }
  const loop = () => { if (!alive) return; paintTop(); draw(); raf = requestAnimationFrame(loop); };
  raf = requestAnimationFrame(loop);
  const ro = new ResizeObserver(() => draw()); ro.observe(wrap);

  wrap.addEventListener('pointerdown', (e) => {
    if (e.target.closest('.sw-h')) return;
    const box = wrap.getBoundingClientRect(), t = tOf(e.clientX - box.left);
    drag = { kind: 'sel', t0: t, x0: e.clientX, moved: false };
    wrap.setPointerCapture(e.pointerId);
  });
  wrap.addEventListener('pointermove', (e) => {
    if (!drag) return;
    const box = wrap.getBoundingClientRect(), t = tOf(e.clientX - box.left);
    if (drag.kind === 'sel') {
      if (Math.abs(e.clientX - drag.x0) > 3) drag.moved = true;
      if (drag.moved) { model.sel = [drag.t0, t]; onSelect(model.sel); }
    } else drag.t = t;
    if (drag.kind !== 'sel') { const hd = el.querySelector(`.sw-h.${drag.kind}`); hd.style.left = `${xOf(t)}px`; }
  });
  wrap.addEventListener('pointerup', async (e) => {
    const d0 = drag; drag = null;
    if (!d0) return;
    if (d0.kind === 'start' || d0.kind === 'end') {
      if (d0.t != null && model.ready && !model.locked) await model.edit(d0.kind === 'start' ? trimStart(model.segs, d0.t) : trimEnd(model.segs, d0.t));
      return draw();
    }
    if (d0.moved) return;
    // a click: on a greyed part, bring it back; anywhere, move the playhead there
    model.sel = null; onSelect(null);
    const gap = model.ready && !model.locked ? gapsOf(model.segs, dur()).find(([a, b]) => d0.t0 >= a && d0.t0 < b) : null;
    if (gap) { if (await model.edit(restoreRange(model.segs, gap[0], gap[1]))) toast(`Brought back ${fmt(gap[1] - gap[0])} s.`); }
    else player.seek(d0.t0);
  });
  for (const k of ['start', 'end']) {
    el.querySelector(`.sw-h.${k}`).addEventListener('pointerdown', (e) => { e.stopPropagation(); drag = { kind: k }; wrap.setPointerCapture(e.pointerId); });
  }
  el.querySelector('.sw-play').onclick = () => (player.playing() ? player.pause() : player.play());
  el.addEventListener('click', async (e) => {
    const a = e.target.closest('[data-a]')?.dataset.a;
    if (a === 'cut' && model.sel) { const [x, y] = model.sel; model.sel = null; onSelect(null); await model.edit(cutRange(model.segs, x, y)); }
    if (a === 'split') await model.edit(splitAt(model.segs, player.time()));
    if (a === 'undo') await model.undoLast();
    if (a === 'unlock') await model.unlock();
  });
  const onKey = (e) => {
    if (/INPUT|TEXTAREA|SELECT/.test(document.activeElement?.tagName || '') || document.activeElement?.isContentEditable) return;
    if ((e.key === 'Delete' || e.key === 'Backspace') && model.sel && model.ready && !model.locked) { e.preventDefault(); el.querySelector('[data-a=cut]').click(); }
    else if ((e.metaKey || e.ctrlKey) && !e.shiftKey && (e.key === 'z' || e.key === 'Z') && model.undo.length) { e.preventDefault(); model.undoLast(); }
  };
  document.addEventListener('keydown', onKey);
  return {
    el,
    update() { loadPeaks(); paintBlocks(); draw(); },
    destroy() { alive = false; cancelAnimationFrame(raf); ro.disconnect(); document.removeEventListener('keydown', onKey); el.remove(); },
  };
}

// ---- the transcript ----
// Words with the cut ones crossed out; a click cuts a word or brings it back; the word playing is lit, and the
// waveform's selection highlights its words.
export function makeTranscript({ host, model, player }) {
  const el = h('<section class="sw-tr" aria-label="Transcript"><div class="sw-tr-body"></div></section>');
  host.append(el);
  const body = el.querySelector('.sw-tr-body');
  let sig = '', spans = [], raf = 0, alive = true, lit = -1;
  function render() {
    const s = JSON.stringify([model.ready, model.words.length, model.segs, model.locked, model.why]);
    if (s === sig) return;
    sig = s;
    if (!model.ready || !model.words.length) {
      body.innerHTML = `<p class="sw-tr-empty">${esc(model.ready ? 'No words in this take yet.' : 'The transcript comes with the rough cut: every word, and the ones I take out crossed through.')}</p>`;
      spans = [];
      return;
    }
    body.replaceChildren();
    spans = model.words.map((w, i) => {
      const b = document.createElement('button');
      b.type = 'button'; b.className = `sw-w${wordCut(model.segs, w) ? ' cut' : ''}`; b.textContent = w[2]; b.dataset.i = i;
      b.title = wordCut(model.segs, w) ? 'Cut · click to bring it back' : 'Click to cut this word';
      body.append(b, ' ');
      return b;
    });
    lit = -1;
  }
  body.addEventListener('click', async (e) => {
    const b = e.target.closest('.sw-w');
    if (!b || !model.ready) return;
    if (model.locked) return toast('The cut is locked. Unlock to edit on the waveform, or tell Claude.');
    const w = model.words[Number(b.dataset.i)];
    // a cut word comes back with the space around it; a kept word goes with the space up to the next word
    const i = Number(b.dataset.i), next = model.words[i + 1];
    await model.edit(wordCut(model.segs, w) ? restoreRange(model.segs, w[0], w[1]) : cutRange(model.segs, w[0], next && next[0] - w[1] < 0.4 ? next[0] : w[1]));
  });
  body.addEventListener('dblclick', (e) => { const b = e.target.closest('.sw-w'); if (b) player.seek(model.words[Number(b.dataset.i)][0]); });
  const loop = () => {
    if (!alive) return;
    if (spans.length) {
      const t = player.time();
      const i = model.words.findIndex((w) => t >= w[0] && t < w[1] + 0.05);
      if (i !== lit) { spans[lit]?.classList.remove('now'); spans[i]?.classList.add('now'); lit = i; }
      const sel = model.sel ? [Math.min(...model.sel), Math.max(...model.sel)] : null;
      const key = sel ? sel.join() : '';
      if (key !== el.dataset.sel) {
        el.dataset.sel = key;
        spans.forEach((sp, k) => sp.classList.toggle('sel', Boolean(sel) && model.words[k][1] > sel[0] && model.words[k][0] < sel[1]));
      }
    }
    raf = requestAnimationFrame(loop);
  };
  raf = requestAnimationFrame(loop);
  return { el, update: render, destroy() { alive = false; cancelAnimationFrame(raf); el.remove(); } };
}
