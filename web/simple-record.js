// Simple mode's Record step (V1 spec §6, boards "V1 · Record", "V1 · Recording" and "V1 · After recording"):
// - the Record page (V1 follow-ups, item 8): a live preview of what the take records in the centre, its controls in one
//   row under it (sources, camera, mic with a level, Record), and "Script (optional)" beside or under it; under all
//   "No script? Just press Record and talk. Already recorded? Drop a file."
// - the full-window teleprompter while recording (web/prompter.js mountPrompter, the engine web/prompter.html runs):
//   black, big text, the current paragraph bright and the rest dimmed, scrolling with the take; at the top the time,
//   the mic level, the sources, "Space to pause · ⌥⌘R to stop", Pause/Resume and Stop; at the bottom Slower · Faster ·
//   Bigger text. No script: the live picture being recorded (Audio only: a big timer and the mic level) instead.
// - the takes: the project's takes for the after-Stop card's "Takes: 1 · 2" (GET /media-items) and Delete take with
//   Undo (the beta.18–22 routes: /rec-delete and /rec-restore for a recorded take, /media-remove and /media-restore for
//   a dropped file; nothing is deleted, the take moves to the studio's trash).
import { $, esc, h, api, toast } from './ui.js';
import * as rec from './recorder.js';
import { HOTKEY } from './recorder.js';
import { mountPrompter, loadScript, saveScript } from './prompter.js';
import { SHAPES, shapeOfType } from './simple.js';
import { mmss, recordPreview, scriptPanel } from './simple-flow.js';
import { meterLevel } from './rec-live.js';

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

// ---- the Record page (V1 follow-ups, item 8: built around a live preview) ----
// Centre: a live preview of exactly what the take records, in the video's shape (web/simple-flow.js recordPreview):
// Camera + screen = the screen with the camera in the style's corner, Camera = the camera, Screen = the screen, Audio
// only = a big mic level and the timer. A screen needs the browser's picker: "Choose what to share…" in the preview
// until one is picked, then it plays live with Change. Directly under it, the preview's controls in one row: the
// source, the camera and mic menus (with a small mic level) and Record. The script is secondary: "Script (optional)",
// one line while empty, open beside the preview (wide) or under the controls (narrow), and the teleprompter while
// recording. The streams are the recorder's (web/recorder.js previewOpen / previewScreen / previewClose); the take
// records the same ones. The preview frame reuses B7's live-take frame (web/rec-live.js, .rl-frame in recorder.css).
export function makeRecordPage({ id, getP, onRecord, onAskScript, onFile }) {
  const el = h(`<section class="sx-rec" aria-label="Record" data-script="closed">
    <div class="sx-pv" data-view="camera">
      <div class="rl-stage"><div class="rl-frame">
        <video class="rl-screen" muted playsinline autoplay aria-label="Your screen, as it will be recorded"></video>
        <div class="rl-cam"><video muted playsinline autoplay aria-label="Your camera, as it will be recorded"></video></div>
        <div class="sx-pv-mic"><span class="sx-pv-time">0:00</span><span class="rp-meter sx-pv-big" aria-hidden="true">${'<i></i>'.repeat(40)}</span><span class="sx-pv-micw">Audio only: your voice, no picture.</span></div>
        <div class="sx-pv-pick"><button type="button" class="btn primary" data-a="screen">Choose what to share…</button><span>Your browser asks which screen or window to record.</span></div>
        <button type="button" class="btn small sx-pv-change" data-a="screen" title="Pick another screen or window">Change</button>
        <div class="sx-pv-wait" role="status"><span class="spin" aria-hidden="true"></span><span>Opening your camera and mic…</span></div>
        <div class="sx-pv-err" role="alert" hidden><span></span><button type="button" class="btn small" data-a="retry">Try again</button></div>
      </div></div>
    </div>
    <div class="sx-rec-ctl" role="group" aria-label="What to record">
      <div class="seg sx-src" role="radiogroup" aria-label="Sources">${Object.entries(SOURCE_LABELS).map(([k, v]) => `<button type="button" role="radio" data-src="${k}">${v}</button>`).join('')}</div>
      <label class="sx-dev" data-dev="camera"><span class="vh">Camera</span><select class="field" data-k="camera" aria-label="Camera"></select></label>
      <label class="sx-dev" data-dev="mic"><span class="vh">Microphone</span><select class="field" data-k="mic" aria-label="Microphone"></select><span class="rp-meter sx-pv-mini" aria-hidden="true">${'<i></i>'.repeat(12)}</span></label>
      <button type="button" class="btn primary big sx-recbtn" data-a="record" title="Record (${esc(HOTKEY)})"><span class="rec-dot" aria-hidden="true"></span>Record</button>
    </div>
    <aside class="sx-scr" aria-label="Script">
      <div class="sx-scr-h"><button type="button" class="sx-scr-t" data-a="script" aria-expanded="false" aria-controls="sxScript"><span class="sx-chev" aria-hidden="true"></span>Script <span class="sub">(optional)</span></button>
        <span class="sx-count sub" aria-live="polite"></span><span class="gap"></span><button type="button" class="btn small ghost" data-a="ask">Ask Claude to write one</button></div>
      <label class="vh" for="sxScript">Your script</label>
      <textarea class="sx-script" id="sxScript" spellcheck="true" placeholder="Paste or write your script here. Cues in brackets, like [pause], show dim so you don't read them out."></textarea>
    </aside>
    <p class="sub sx-rec-foot">No script? Just press Record and talk. Already recorded? <button type="button" class="linkish" data-a="file">Drop a file</button>.<input type="file" hidden accept="video/*,audio/*,.mov,.mp4,.m4v,.mkv,.webm,.wav,.m4a,.mp3,.aif,.aiff,.caf,.flac"></p>
  </section>`);
  const ta = $('.sx-script', el), input = $('input[type=file]', el), pvEl = $('.sx-pv', el), frame = $('.rl-frame', el);
  const scr = $('.rl-screen', el), camBox = $('.rl-cam', el), cam = $('video', camBox);
  const P0 = getP() || {};
  let src = sourcesFor(id, P0), saveT = 0, dirty = false, saved = '', scriptOpen = null, visible = false, opening = 0, err = null;
  const picks = { camera: store.get(`studio.simple.camera`, P0.recorder?.camera && P0.recorder.camera !== 'none' ? P0.recorder.camera : 'default'),
    mic: store.get(`studio.simple.mic`, P0.recorder?.mic && P0.recorder.mic !== 'none' ? P0.recorder.mic : 'default') };
  const aspect = () => (shapeOfType(getP()?.type) === 'reel' ? '9:16' : getP()?.layout?.aspect === '9:16' ? '9:16' : '16:9');
  const plan = () => recordPreview(src, { aspect: aspect(), streams: rec.previewStreams() || {}, layout: getP()?.layout });

  // ---- the preview ----
  function paint() {
    const pl = plan(), st = rec.previewStreams() || {};
    pvEl.dataset.view = pl.view;
    pvEl.dataset.frame = pl.frame;
    el.dataset.frame = pl.frame;
    frame.classList.toggle('cam-only', pl.cameraFills);
    const wantScreen = pl.screen ? st.screen || null : null, wantCam = pl.camera ? st.cam || null : null;
    if (scr.srcObject !== wantScreen) scr.srcObject = wantScreen;
    if (cam.srcObject !== wantCam) cam.srcObject = wantCam;
    camBox.hidden = !pl.camera || !st.cam;
    if (pl.corner) Object.assign(camBox.style, { left: `${pl.corner.x * 100}%`, top: `${pl.corner.y * 100}%`, width: `${pl.corner.w * 100}%`, right: 'auto', bottom: 'auto' });
    else camBox.removeAttribute('style');
    $('.sx-pv-pick', el).hidden = !pl.pickScreen;
    $('.sx-pv-change', el).hidden = !pl.changeScreen;
    $('.sx-pv-wait', el).hidden = !(opening && !err);
    const e = $('.sx-pv-err', el);
    e.hidden = !err; if (err) $('span', e).textContent = err;
    $('[data-dev=camera]', el).hidden = !pl.cameraPicker;
    el.querySelectorAll('[data-src]').forEach((b) => { const on = b.dataset.src === src; b.classList.toggle('on', on); b.setAttribute('aria-checked', String(on)); });
    meterOn(st.mic || null);
  }
  // Open what this source needs (the camera only when it shows), then the device menus with their names.
  async function openDevices() {
    if (!visible) return;
    const pl = plan(), tok = ++opening;
    err = null; paint();
    try { await rec.previewOpen({ camera: pl.camera ? picks.camera : 'none', mic: picks.mic }); }
    catch (e) { err = e.message || String(e); }
    if (tok !== opening) return;
    opening = 0;
    await fillMenus();
    paint();
  }
  async function fillMenus() {
    const { cameras, mics } = await rec.deviceLists();
    const fill = (sel, list, cur, word) => {
      const opts = list.length ? list : [{ id: 'default', label: `Your ${word}` }];
      sel.innerHTML = opts.map((x) => `<option value="${esc(x.id)}">${esc(x.label)}</option>`).join('');
      sel.value = opts.some((x) => x.id === cur) ? cur : opts[0].id;
    };
    fill($('[data-k=camera]', el), cameras, picks.camera, 'camera');
    fill($('[data-k=mic]', el), mics, picks.mic, 'microphone');
  }
  // The mic level: a small meter by the mic menu, and the big one for Audio only.
  let meter = null;
  const mini = [...el.querySelectorAll('.sx-pv-mini i')], big = [...el.querySelectorAll('.sx-pv-big i')];
  function meterOn(mic) {
    if (meter?.mic === mic) return;
    meterOff();
    if (!mic || !window.AudioContext) return;
    try {
      const m = meter = { mic, ctx: new AudioContext(), raf: 0 };
      const an = m.ctx.createAnalyser();
      an.fftSize = 2048;
      m.ctx.createMediaStreamSource(mic).connect(an);
      const buf = new Float32Array(an.fftSize);
      const tone = (i, n) => (i < n * 0.7 ? 'g' : i < n * 0.88 ? 'a' : 'r');
      const loop = () => {
        if (meter !== m) return;
        an.getFloatTimeDomainData(buf);
        let pk = 0; for (const v of buf) pk = Math.max(pk, Math.abs(v));
        const db = 20 * Math.log10(pk || 1e-6);
        for (const bars of [mini, big]) { const n = meterLevel(db, bars.length); bars.forEach((b, i) => (b.className = i < n ? tone(i, bars.length) : '')); }
        $('.sx-pv-micw', el).textContent = db > -3 ? 'Too loud: move back a little.' : db > -30 ? 'Good level.' : 'Say a sentence at your normal voice.';
        m.raf = requestAnimationFrame(loop);
      };
      loop();
    } catch { meter = null; }
  }
  function meterOff() { if (!meter) return; cancelAnimationFrame(meter.raf); meter.ctx.close().catch(() => {}); meter = null; [...mini, ...big].forEach((b) => (b.className = '')); }
  const offPv = rec.onPreview(() => paint());

  // ---- the script ----
  const paintScript = () => {
    const sp = scriptPanel({ text: ta.value, open: scriptOpen, width: innerWidth });
    el.dataset.script = sp.open ? 'open' : 'closed';
    $('[data-a=script]', el).setAttribute('aria-expanded', String(sp.open));
    $('.sx-count', el).textContent = sp.line;
    ta.hidden = !sp.open;
  };
  const save = async () => { clearTimeout(saveT); if (!dirty) return; dirty = false; const t = ta.value; try { await saveScript(id, t); saved = t; } catch (e) { toast(`Couldn't save the script: ${e.message}`); } };
  ta.addEventListener('input', () => { dirty = true; paintScript(); clearTimeout(saveT); saveT = setTimeout(save, 700); });
  ta.addEventListener('blur', save);

  el.querySelectorAll('[data-src]').forEach((b) => (b.onclick = () => { src = b.dataset.src; store.set(`studio.simple.sources.${id}`, src); paint(); openDevices(); }));
  el.addEventListener('change', (e) => {
    const k = e.target.dataset.k;
    if (k !== 'camera' && k !== 'mic') return;
    picks[k] = e.target.value; store.set(`studio.simple.${k}`, picks[k]);
    openDevices();
  });
  el.addEventListener('click', async (e) => {
    const a = e.target.closest('[data-a]')?.dataset.a;
    if (a === 'ask') onAskScript();
    if (a === 'file') input.click();
    if (a === 'script') { scriptOpen = !scriptPanel({ text: ta.value, open: scriptOpen }).open; paintScript(); if (scriptOpen) ta.focus(); }
    if (a === 'retry') openDevices();
    if (a === 'screen') { err = null; try { await rec.previewScreen(); } catch (x) { err = x.message; } paint(); }
    if (a === 'record') { await save(); onRecord(src, ta.value, { camera: picks.camera, mic: picks.mic }); }
  });
  input.onchange = () => { if (input.files[0]) onFile(input.files[0]); input.value = ''; };
  const onResize = () => paintScript();
  addEventListener('resize', onResize);
  // The script from script.md (Claude may write it): read again unless the creator is typing.
  async function reload() {
    if (dirty || document.activeElement === ta) return;
    const t = await loadScript(id);
    if (t !== saved || ta.value !== t) { saved = t; ta.value = t; paintScript(); }
  }
  // Shown: open the preview's streams; hidden (a take landed, another step): let them go.
  function show(v) {
    if (v === visible) return;
    visible = v;
    if (v) { paint(); openDevices(); } else { opening = 0; meterOff(); if (rec.session().phase === 'idle') rec.previewClose(); scr.srcObject = null; cam.srcObject = null; }
  }
  paint(); paintScript(); reload();
  return { el, reload, show, sources: () => src, text: () => ta.value, devices: () => ({ ...picks }),
    destroy() { clearTimeout(saveT); save(); show(false); offPv(); removeEventListener('resize', onResize); el.remove(); } };
}

// ---- the full-window teleprompter ----
// Shown from the countdown's end to Stop; closes itself when the take is saving.
let open = null;
export function openTeleprompter({ id, text, sources, frame = '16:9', corner = null }) {
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
    <div class="vt-body">${hasScript ? '<div class="vt-host"></div>' : sources !== 'audio' ? `<div class="vt-live" data-frame="${frame === '9:16' ? '9:16' : '16:9'}"><div class="rl-stage"><div class="rl-frame${sources === 'camera' ? ' cam-only' : ''}"><video class="rl-screen" muted playsinline autoplay aria-label="The screen being recorded"></video><div class="rl-cam"><video muted playsinline autoplay aria-label="The camera being recorded"></video></div></div></div></div>` : '<div class="vt-big"><span class="vt-bigtime">0:00</span><span class="vt-bigmeter" aria-hidden="true">' + '<i></i>'.repeat(24) + '</span><span class="vt-sub">Just talk. Press Stop when you’re done.</span></div>'}</div>
    ${hasScript ? '<div class="vt-bottom"><button type="button" class="vt-btn" data-p="slower">Slower</button><button type="button" class="vt-btn" data-p="faster">Faster</button><button type="button" class="vt-btn" data-p="bigger">Bigger text</button><button type="button" class="vt-btn ghost" data-p="smaller">Smaller</button></div>' : ''}
  </div>`);
  document.body.append(ov);
  document.body.classList.add('vt-open');
  const p = hasScript ? mountPrompter($('.vt-host', ov), text, { paragraphs: true, onSpace: () => rec.togglePause(), fullscreen: ov }) : null;
  // No script: the live picture (the same streams the take records), the camera in the style's corner.
  const live = $('.vt-live', ov);
  const paintLive = () => {
    if (!live) return;
    const st = rec.liveStreams() || {}, sv = $('.rl-screen', live), cb = $('.rl-cam', live), cv = $('video', cb);
    if (sv.srcObject !== (st.screen || null)) sv.srcObject = st.screen || null;
    if (cv.srcObject !== (st.cam || null)) cv.srcObject = st.cam || null;
    cb.hidden = !st.cam;
    if (corner && st.screen) Object.assign(cb.style, { left: `${corner.x * 100}%`, top: `${corner.y * 100}%`, width: `${corner.w * 100}%`, right: 'auto', bottom: 'auto' });
  };
  paintLive();
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
    paintLive();
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
