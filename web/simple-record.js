// Simple mode's Record step (V1 spec §6, boards "V1 · Record", "V1 · Recording" and "V1 · After recording"):
// - the Record page: "Your script" (paste or write it; Ask Claude to write one), the sources (Camera + screen · Camera ·
//   Screen · Audio only, defaulting from the shape), the word count and length, and one big Record button; under it
//   "No script? Just press Record and talk. Already recorded? Drop a file."
// - the full-window teleprompter while recording (web/prompter.js mountPrompter, the engine web/prompter.html runs):
//   black, big text, the current paragraph bright and the rest dimmed, scrolling with the take; at the top the time,
//   the mic level, the sources, "Space to pause · ⌥⌘R to stop", Pause/Resume and Stop; at the bottom Slower · Faster ·
//   Bigger text. No script: a big timer and the mic level instead. Audio only works the same way.
// - the takes: the project's takes for the after-Stop card's "Takes: 1 · 2" (GET /media-items) and Delete take with
//   Undo (the beta.18–22 routes: /rec-delete and /rec-restore for a recorded take, /media-remove and /media-restore for
//   a dropped file; nothing is deleted, the take moves to the studio's trash).
import { $, esc, h, api, toast } from './ui.js';
import * as rec from './recorder.js';
import { HOTKEY } from './recorder.js';
import { mountPrompter, loadScript, saveScript, words } from './prompter.js';
import { SHAPES, shapeOfType } from './simple.js';
import { mmss } from './simple-flow.js';

export const SOURCE_LABELS = { 'camera-screen': 'Camera + screen', camera: 'Camera', screen: 'Screen', audio: 'Audio only' };
const store = {
  get(k, d) { try { const v = localStorage.getItem(k); return v == null ? d : v; } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch {} },
};
// The sources a video records with: the creator's last pick for it, else its shape's default.
export function sourcesFor(id, P) {
  const mine = store.get(`studio.simple.sources.${id}`, '');
  return SOURCE_LABELS[mine] ? mine : SHAPES[shapeOfType(P?.type)]?.sources || 'camera';
}
const spoken = (n) => { const m = n / 150; return m < 1 ? 'under a minute' : `about ${Math.round(m)} min`; };

// ---- the Record page ----
export function makeRecordPage({ id, getP, onRecord, onAskScript, onFile }) {
  const el = h(`<section class="sx-rec" aria-labelledby="sxRecH">
    <div class="sx-rec-h"><h2 id="sxRecH">Your script</h2><span class="gap"></span><button type="button" class="btn small" data-a="ask">Ask Claude to write one</button></div>
    <label class="vh" for="sxScript">Your script</label>
    <textarea class="sx-script" id="sxScript" spellcheck="true" placeholder="Paste or write your script here. Cues in brackets, like [pause], show dim so you don't read them out."></textarea>
    <div class="sx-rec-row">
      <div class="seg sx-src" role="radiogroup" aria-label="What to record">${Object.entries(SOURCE_LABELS).map(([k, v]) => `<button type="button" role="radio" data-src="${k}">${v}</button>`).join('')}</div>
      <span class="sx-count sub" aria-live="polite"></span><span class="gap"></span>
      <button type="button" class="btn primary big sx-recbtn" data-a="record" title="Record (${esc(HOTKEY)})"><span class="rec-dot" aria-hidden="true"></span>Record</button>
    </div>
    <p class="sub sx-rec-foot">No script? Just press Record and talk. Already recorded? <button type="button" class="linkish" data-a="file">Drop a file</button>.<input type="file" hidden accept="video/*,audio/*,.mov,.mp4,.m4v,.mkv,.webm,.wav,.m4a,.mp3,.aif,.aiff,.caf,.flac"></p>
  </section>`);
  const ta = $('.sx-script', el), input = $('input[type=file]', el);
  let src = sourcesFor(id, getP()), saveT = 0, dirty = false, saved = '';
  const paintSrc = () => el.querySelectorAll('[data-src]').forEach((b) => { const on = b.dataset.src === src; b.classList.toggle('on', on); b.setAttribute('aria-checked', String(on)); });
  const count = () => { const n = words(ta.value); $('.sx-count', el).textContent = n ? `${n.toLocaleString()} word${n === 1 ? '' : 's'} · ${spoken(n)}` : ''; };
  const save = async () => { clearTimeout(saveT); if (!dirty) return; dirty = false; const t = ta.value; try { await saveScript(id, t); saved = t; } catch (e) { toast(`Couldn't save the script: ${e.message}`); } };
  ta.addEventListener('input', () => { dirty = true; count(); clearTimeout(saveT); saveT = setTimeout(save, 700); });
  ta.addEventListener('blur', save);
  el.querySelectorAll('[data-src]').forEach((b) => (b.onclick = () => { src = b.dataset.src; store.set(`studio.simple.sources.${id}`, src); paintSrc(); }));
  el.addEventListener('click', async (e) => {
    const a = e.target.closest('[data-a]')?.dataset.a;
    if (a === 'ask') onAskScript();
    if (a === 'file') input.click();
    if (a === 'record') { await save(); onRecord(src, ta.value); }
  });
  input.onchange = () => { if (input.files[0]) onFile(input.files[0]); input.value = ''; };
  // The script from script.md (Claude may write it): read again unless the creator is typing.
  async function reload() {
    if (dirty || document.activeElement === ta) return;
    const t = await loadScript(id);
    if (t !== saved || ta.value !== t) { saved = t; ta.value = t; count(); }
  }
  paintSrc(); reload();
  return { el, reload, sources: () => src, text: () => ta.value, destroy() { clearTimeout(saveT); save(); el.remove(); } };
}

// ---- the full-window teleprompter ----
// Shown from the countdown's end to Stop; closes itself when the take is saving.
let open = null;
export function openTeleprompter({ id, text, sources }) {
  open?.close();
  const hasScript = Boolean(String(text || '').trim());
  const ov = h(`<div class="vt" role="dialog" aria-modal="true" aria-label="Recording">
    <div class="vt-top">
      <span class="vt-state"><i class="vt-dot" aria-hidden="true"></i><span class="vt-label">Starting…</span> <span class="vt-time">0:00</span></span>
      <span class="vt-meter" aria-hidden="true">${'<i></i>'.repeat(10)}</span>
      <span class="vt-src">${esc(SOURCE_LABELS[sources] || '')}</span>
      <span class="gap"></span>
      <span class="vt-hint">Space to pause · ${esc(HOTKEY)} to stop</span>
      <button type="button" class="vt-btn" data-a="pause">Pause</button>
      <button type="button" class="vt-btn stop" data-a="stop"><span class="sq" aria-hidden="true"></span>Stop</button>
    </div>
    <div class="vt-body">${hasScript ? '<div class="vt-host"></div>' : '<div class="vt-big"><span class="vt-bigtime">0:00</span><span class="vt-bigmeter" aria-hidden="true">' + '<i></i>'.repeat(24) + '</span><span class="vt-sub">Just talk. Press Stop when you’re done.</span></div>'}</div>
    ${hasScript ? '<div class="vt-bottom"><button type="button" class="vt-btn" data-p="slower">Slower</button><button type="button" class="vt-btn" data-p="faster">Faster</button><button type="button" class="vt-btn" data-p="bigger">Bigger text</button><button type="button" class="vt-btn ghost" data-p="smaller">Smaller</button></div>' : ''}
  </div>`);
  document.body.append(ov);
  document.body.classList.add('vt-open');
  const p = hasScript ? mountPrompter($('.vt-host', ov), text, { paragraphs: true, onSpace: () => rec.togglePause(), fullscreen: ov }) : null;
  ov.addEventListener('click', (e) => {
    const a = e.target.closest('[data-a]')?.dataset.a, pa = e.target.closest('[data-p]')?.dataset.p;
    if (a === 'pause') rec.togglePause();
    if (a === 'stop') rec.stop();
    if (pa && p) p.act[pa]();
  });
  // Space without a script pauses too (with one, the prompter's own Space does).
  const onKey = (e) => {
    if (e.key !== ' ' || e.metaKey || e.ctrlKey || e.altKey || p) return;
    e.preventDefault(); e.stopPropagation(); rec.togglePause();
  };
  addEventListener('keydown', onKey, true);
  // The mic level: the loudest sample of each frame, 10 (24) bars from -60 to 0 dB.
  let meter = null, raf = 0, started = false, wasPlaying = false, paused = false;
  const bars = [...ov.querySelectorAll('.vt-meter i')], big = [...ov.querySelectorAll('.vt-bigmeter i')];
  function meterOn() {
    if (meter) return;
    const mic = rec.liveStreams()?.mic;
    if (!mic) return;
    try {
      const ctx = new AudioContext(), an = ctx.createAnalyser();
      an.fftSize = 1024; ctx.createMediaStreamSource(mic).connect(an);
      meter = { ctx, an, buf: new Float32Array(an.fftSize) };
    } catch { meter = null; }
  }
  const tick = () => {
    const S = rec.session();
    const t = S.phase === 'recording' ? Date.now() - S.startedAt : 0;
    $('.vt-time', ov).textContent = mmss(t / 1000);
    const bt = $('.vt-bigtime', ov); if (bt) bt.textContent = mmss(t / 1000);
    meterOn();
    if (meter) {
      meter.an.getFloatTimeDomainData(meter.buf);
      let pk = 0; for (const v of meter.buf) pk = Math.max(pk, Math.abs(v));
      const l = Math.max(0, Math.min(1, (20 * Math.log10(pk || 1e-6) + 60) / 60));
      bars.forEach((b, i) => b.classList.toggle('on', i < Math.round(l * bars.length) && !S.paused));
      big.forEach((b, i) => b.classList.toggle('on', i < Math.round(l * big.length) && !S.paused));
    }
    raf = requestAnimationFrame(tick);
  };
  raf = requestAnimationFrame(tick);
  const paint = (S) => {
    ov.dataset.phase = S.phase === 'recording' && S.paused ? 'paused' : S.phase;
    $('.vt-label', ov).textContent = S.phase === 'recording' ? (S.paused ? 'Paused' : 'Recording') : S.phase === 'stopping' ? 'Finishing…' : 'Starting…';
    const pb = $('[data-a=pause]', ov);
    pb.textContent = S.paused ? 'Resume' : 'Pause';
    pb.setAttribute('aria-pressed', String(Boolean(S.paused)));
    pb.disabled = $('[data-a=stop]', ov).disabled = S.phase !== 'recording';
  };
  const off = rec.onSession((S) => {
    if (S.project && S.project !== id) return;
    paint(S);
    if (S.phase === 'recording' && !started) { started = true; p?.play(true); }
    if (S.phase === 'recording' && started && Boolean(S.paused) !== paused) {
      paused = Boolean(S.paused);
      if (paused) { wasPlaying = p?.playing; p?.play(false); } else if (wasPlaying) p?.play(true);
    }
    if (['saving', 'idle'].includes(S.phase)) close();
  });
  paint(rec.session());
  function close() {
    if (!ov.isConnected) return;
    off(); cancelAnimationFrame(raf); removeEventListener('keydown', onKey, true);
    meter?.ctx.close().catch(() => {});
    p?.destroy(); ov.remove(); document.body.classList.remove('vt-open');
    if (open?.ov === ov) open = null;
  }
  open = { ov, close };
  return open;
}

// ---- the takes ----
// The project's takes, oldest first, numbered: [{ id, n, duration, canvas, recorded }].
export async function listTakes(id) {
  try {
    const r = await api(`/api/projects/${encodeURIComponent(id)}/media-items`);
    return (r.items || []).filter((x) => x.take).sort((a, b) => a.at - b.at).map((x, i) => ({ id: x.id, n: i + 1, duration: x.duration, canvas: x.canvas, recorded: x.recorded }));
  } catch { return []; }
}
// Delete take (soft): to the studio's trash, with Undo. Returns { trash, kind } or { confirm } when the server asks first.
export async function deleteTake(id, take, { confirm = false } = {}) {
  if (take.recorded) {
    const r = await rec.deleteTake(id, take.id, { confirm });
    if (r.ok === false && r.confirm) return { confirm: r.confirm };
    if (r.ok === false) throw new Error(r.error || 'The take couldn’t be deleted.');
    return { trash: r.trash, kind: 'rec' };
  }
  const r = await api(`/api/projects/${encodeURIComponent(id)}/media-remove`, { item: take.id, ...(confirm ? { confirm: true } : {}) });
  if (r.ok === false && r.confirm) return { confirm: r.confirm };
  if (r.ok === false) throw new Error(r.error || 'The take couldn’t be deleted.');
  return { trash: r.trash || r.entry, kind: 'media' };
}
export async function restoreTake(id, d) {
  if (d.kind === 'rec') return rec.restoreTake(id, d.trash);
  return api(`/api/projects/${encodeURIComponent(id)}/media-restore`, { trash: d.trash });
}
export async function useTake(id, take) {
  const r = await api(`/api/projects/${encodeURIComponent(id)}/media-use`, { item: take.id, confirm: true });
  if (r.ok === false) throw new Error(r.error || r.confirm || 'That take couldn’t be used.');
  return r;
}
