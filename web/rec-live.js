// The canvas while a take records (B7, wireflow J1 step 1). Instead of "How do you want to start?" (or the old take),
// the editor's canvas shows what is being recorded: the screen with the camera in its corner (the camera alone, or a
// big mic level for a mic-only take), the mic level and the time, with the recorder's own bar (Pause, Restart, Stop:
// web/recorder.js) docked under the picture. After Stop it says "Saving the take…" until the take lands in the project.
// The streams are the recorder's (liveStreams); this view only watches them and never stops them.
import { h, $ } from './ui.js';

// After the save finished: how long the canvas waits for the project to show the take before giving up quietly.
export const LAND_WAIT_MS = 20000;

// What the canvas shows for the recorder's session S in project `id`: 'starting', 'live', 'paused', 'saving' or null.
// hasTake: the project shows a take now (a landed take ends "Saving the take…"). A take recorded into a block never
// reaches the canvas, so nothing waits for it there.
export function liveMode(S, { id, hasTake = false, now = Date.now() } = {}) {
  if (!S || !id || S.project !== id) return null;
  if (S.phase === 'starting') return 'starting';
  if (S.phase === 'recording') return S.paused ? 'paused' : 'live';
  if (S.phase === 'stopping' || S.phase === 'saving') return 'saving';
  if (S.phase === 'idle' && S.landed && !hasTake && !/^block:/.test(S.target || '') && now - (S.landed.at || 0) < LAND_WAIT_MS) return 'saving';
  return null;
}
export const LIVE_WORDS = { starting: 'Starting…', live: 'Recording', paused: 'Paused', saving: 'Saving the take…' };
// The Media section's card while there's no take yet: what it says instead of "No recording yet".
export function liveCard(mode) {
  if (!mode) return null;
  if (mode === 'saving') return { title: 'Saving the take…', sub: 'It lands here in a moment.' };
  return { title: mode === 'paused' ? 'Recording · paused' : mode === 'starting' ? 'Starting the take…' : 'Recording now', sub: 'The take lands here when you stop.' };
}
export const mmss = (ms) => { const s = Math.max(0, Math.floor(ms / 1000)); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; };
// The meter's lit segments for a peak in dBFS (40 segments, -60 to 0 dB), as the record panel draws them.
export const meterLevel = (db, n = 40) => Math.round(Math.max(0, Math.min(1, (db + 60) / 60)) * n);

// rec: web/recorder.js (session, onSession, liveStreams, dockControls, undockControls). hasTake(): the project shows a
// take. Returns { el, update(visible) → mode, mode(), destroy() }; update() is called on every project refresh and tab
// switch (visible: the canvas is the open pane), and runs by itself on session changes.
export function makeLiveView({ rec, id, hasTake, onChange }) {
  const { session, onSession, liveStreams, dockControls, undockControls } = rec;
  const el = h(`<section class="rec-live" aria-label="The take being recorded" hidden>
    <div class="rl-stage">
      <div class="rl-frame">
        <video class="rl-screen" muted playsinline autoplay aria-label="The screen being recorded"></video>
        <div class="rl-cam"><video muted playsinline autoplay aria-label="The camera being recorded"></video></div>
        <span class="rl-tag" role="status"><i aria-hidden="true"></i><span class="rl-word"></span><span class="rl-time"></span></span>
        <div class="rl-saving" role="status"><span class="spin" aria-hidden="true"></span><b>Saving the take…</b><small class="rl-prog"></small></div>
      </div>
    </div>
    <div class="rl-bar">
      <div class="rl-mic"><b>Mic</b><div class="rp-meter rl-meter" aria-hidden="true">${'<i></i>'.repeat(40)}</div><span class="rl-micw"></span></div>
      <div class="rl-ctl"></div>
    </div>
  </section>`);
  const scr = $('.rl-screen', el), camBox = $('.rl-cam', el), cam = $('video', camBox), frame = $('.rl-frame', el), ctl = $('.rl-ctl', el);
  const segs = [...el.querySelectorAll('.rl-meter i')];
  let mode = null, visible = false, docked = false, meter = null, tick = 0, landT = 0;

  function meterOn(mic) {
    if (meter?.mic === mic) return;
    meterOff();
    if (!mic || !window.AudioContext) return;
    try {
      const m = meter = { mic, ctx: new AudioContext(), raf: 0 };
      const an = m.ctx.createAnalyser();
      an.fftSize = 2048;
      m.ctx.createMediaStreamSource(mic).connect(an);
      const buf = new Float32Array(an.fftSize), recent = [];
      const loop = () => {
        if (meter !== m) return;
        an.getFloatTimeDomainData(buf);
        let pk = 0; for (const v of buf) pk = Math.max(pk, Math.abs(v));
        const db = 20 * Math.log10(pk || 1e-6), n = meterLevel(db, segs.length);
        recent.push(db); if (recent.length > 120) recent.shift();
        const top = Math.max(...recent), hold = meterLevel(top, segs.length) - 1;
        const tone = (i) => (i < 28 ? 'g' : i < 35 ? 'a' : 'r');
        segs.forEach((s, i) => (s.className = i < n ? tone(i) : i === hold && top > -60 ? `${tone(i)} pk` : ''));
        $('.rl-micw', el).textContent = top > -3 ? 'Too loud' : top > -30 ? 'Good level' : 'Quiet';
        m.raf = requestAnimationFrame(loop);
      };
      loop();
    } catch { meter = null; }
  }
  function meterOff() {
    if (!meter) return;
    cancelAnimationFrame(meter.raf);
    meter.ctx.close().catch(() => {});
    meter = null;
    segs.forEach((s) => (s.className = ''));
  }
  const paintTime = () => {
    const S = session();
    $('.rl-time', el).textContent = mode === 'live' || mode === 'paused' ? mmss(Date.now() - S.startedAt) : '';
  };

  function update(isVisible = visible) {
    visible = isVisible;
    const S = session();
    const was = mode;
    mode = liveMode(S, { id, hasTake: hasTake() });
    const show = Boolean(mode) && visible;
    el.hidden = !show;
    el.dataset.mode = mode || '';
    // The recorder's bar sits under the picture while the view shows (under the script's bar, if that's up).
    if (show && !docked) { dockControls(ctl, { under: true }); docked = true; }
    if (!show && docked) { undockControls(ctl); docked = false; }
    const st = show && mode !== 'saving' ? liveStreams() : null;
    const kind = S.kind || (st?.screen ? 'screen' : st?.cam ? 'camera' : st?.mic ? 'mic' : null);
    if (scr.srcObject !== (st?.screen || null)) scr.srcObject = st?.screen || null;
    if (cam.srcObject !== (st?.cam || null)) cam.srcObject = st?.cam || null;
    frame.classList.toggle('cam-only', kind === 'camera' || (!st?.screen && Boolean(st?.cam)));
    el.classList.toggle('mic-only', kind === 'mic');
    camBox.hidden = !st?.cam;
    if (st?.mic && (mode === 'live' || mode === 'paused' || mode === 'starting')) meterOn(st.mic); else meterOff();
    $('.rl-word', el).textContent = LIVE_WORDS[mode] || '';
    $('.rl-prog', el).textContent = S.phase === 'saving' ? `${Math.round((S.progress || 0) * 100)}%` : S.phase === 'stopping' ? 'Sending the last seconds…' : 'It lands here in a moment.';
    paintTime();
    clearInterval(tick);
    tick = show && (mode === 'live' || mode === 'paused') ? setInterval(paintTime, 250) : 0;
    // Waiting for the landed take: look again when the wait runs out.
    clearTimeout(landT);
    if (mode === 'saving' && S.phase === 'idle') landT = setTimeout(() => update(), LAND_WAIT_MS + 50);
    if (was !== mode) onChange?.(mode, was);
    return mode;
  }
  const unsub = onSession(() => update());
  return {
    el, update, mode: () => mode,
    destroy() { unsub(); clearInterval(tick); clearTimeout(landT); meterOff(); if (docked) undockControls(ctl); scr.srcObject = null; cam.srcObject = null; el.remove(); },
  };
}
