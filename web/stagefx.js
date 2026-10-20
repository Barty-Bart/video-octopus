// Control room's extras on the Canvas picture:
// a dashed title-safe guide on the picture, 6 % in from its top and bottom and 5 % from its sides (as on the board),
// and two level meters beside it, left and right, green / amber / red, from what the canvas player is playing.
//
// The levels come from AnalyserNodes on a copy of each playing element's sound (captureStream), so the player's own
// sound never goes through Web Audio: if anything here fails, or the browser has no captureStream (Safari), playback
// and sound go on exactly as before and the meters just stay dark. A gain per element follows what the player makes
// audible (its mute and volume), so the meters show what you hear. Nothing is built in the other looks; switching
// away, or leaving the canvas, stops the loop, the captured tracks and the AudioContext.
import { h } from './ui.js';
import { onLook, currentLook } from './appearance.js';

const FLOOR = -48;      // dBFS at the bottom of a meter: green → amber at 62 % ≈ −18 dBFS, amber → red at 84 % ≈ −7.7 dBFS
const RELEASE = 26;     // dB per second a bar falls back (it rises at once)
const HOLD = 1.2;       // seconds the peak mark holds before it falls

// host: the .canvas-wrap; stage: the picture's <canvas>; media(): the player's <video>/<audio> elements.
export function stageExtras(host, stage, media) {
  let ui = null, audio = null, noAudio = false, raf = 0, ro = null, last = 0, els = [];
  const lv = [0, 0], pk = [0, 0], pkAt = [0, 0];

  // ---- the guide and the meters, kept on the picture as it moves and resizes ----
  function place() {
    if (!ui || !stage.isConnected) return;
    const x = stage.offsetLeft, y = stage.offsetTop, w = stage.offsetWidth, ht = stage.offsetHeight;
    Object.assign(ui.safe.style, { left: `${x}px`, top: `${y}px`, width: `${w}px`, height: `${ht}px` });
    // beside the picture, centred in the room to its right (the stage's padding at least)
    const mw = ui.meters.offsetWidth || 15, room = host.clientWidth - (x + w);
    const gap = Math.max(2, Math.min(12, (room - mw) / 2));
    Object.assign(ui.meters.style, { left: `${x + w + gap}px`, top: `${y}px`, height: `${ht}px` });
  }
  function paint() {
    if (!ui) return;
    ui.bars.forEach((b, c) => { b.style.setProperty('--lv', lv[c].toFixed(3)); b.style.setProperty('--pk', pk[c].toFixed(3)); });
  }

  // ---- the levels ----
  function startAudio() {
    if (audio || noAudio) return;
    try {
      const AC = window.AudioContext || window.webkitAudioContext;
      const list = els.filter((m) => typeof m.captureStream === 'function');
      if (!AC || !list.length) { noAudio = true; return; }
      const ctx = new AC();
      // every element's copy sums into a stereo bus (a mono take fills both sides), split into left and right
      const bus = ctx.createGain(); bus.channelCount = 2; bus.channelCountMode = 'explicit'; bus.channelInterpretation = 'speakers';
      const split = ctx.createChannelSplitter(2); bus.connect(split);
      const an = [0, 1].map((c) => { const a = ctx.createAnalyser(); a.fftSize = 1024; split.connect(a, c); return a; });
      const sink = ctx.createGain(); sink.gain.value = 0; // keeps the analysers running; nothing is heard from here
      an.forEach((a) => a.connect(sink)); sink.connect(ctx.destination);
      audio = { ctx, bus, an, buf: new Float32Array(1024), srcs: [] };
      for (const el of list) tap(el);
    } catch { noAudio = true; stopAudio(); }
  }
  function tap(el) {
    let stream;
    try { stream = el.captureStream(); } catch { return; }
    const gain = audio.ctx.createGain(); gain.gain.value = 0; gain.connect(audio.bus);
    const s = { el, stream, gain, src: null };
    // only the sound is needed: the copy's picture is stopped so it costs nothing; the sound joins once it exists
    const join = () => {
      for (const t of stream.getVideoTracks()) t.stop();
      if (s.src || !audio || !stream.getAudioTracks().length) return;
      try { s.src = audio.ctx.createMediaStreamSource(stream); s.src.connect(gain); } catch {}
    };
    s.join = join;
    stream.addEventListener('addtrack', join);
    join();
    audio.srcs.push(s);
  }
  function stopAudio() {
    if (!audio) return;
    for (const s of audio.srcs) {
      s.stream.removeEventListener('addtrack', s.join);
      try { s.src?.disconnect(); s.gain.disconnect(); } catch {}
      for (const t of s.stream.getTracks()) t.stop(); // the copies only: the element plays on
    }
    audio.ctx.close().catch(() => {});
    audio = null;
  }

  function tick() {
    raf = 0;
    if (!ui) return;
    const now = performance.now() / 1000, dt = Math.min(0.1, Math.max(0, now - last)); last = now;
    const fall = (RELEASE / -FLOOR) * dt;
    let playing = false;
    for (const el of els) if (!el.paused) playing = true;
    if (audio) {
      for (const s of audio.srcs) {
        const g = s.el.paused || s.el.muted ? 0 : s.el.volume;
        if (Math.abs(s.gain.gain.value - g) > 0.001) s.gain.gain.value = g;
      }
      for (let c = 0; c < 2; c++) {
        audio.an[c].getFloatTimeDomainData(audio.buf);
        let p = 0;
        for (let i = 0; i < audio.buf.length; i++) { const a = Math.abs(audio.buf[i]); if (a > p) p = a; }
        const v = p > 0 ? Math.max(0, Math.min(1, (20 * Math.log10(p) - FLOOR) / -FLOOR)) : 0;
        lv[c] = v >= lv[c] ? v : Math.max(v, lv[c] - fall);
        if (lv[c] >= pk[c]) { pk[c] = lv[c]; pkAt[c] = now; } else if (now - pkAt[c] > HOLD) pk[c] = Math.max(lv[c], pk[c] - fall);
      }
    } else for (let c = 0; c < 2; c++) { lv[c] = Math.max(0, lv[c] - fall); pk[c] = Math.max(0, pk[c] - fall); }
    paint();
    // runs while something plays, then until the bars have fallen
    if (playing || lv[0] + lv[1] + pk[0] + pk[1] > 0.002) raf = requestAnimationFrame(tick);
  }
  const kick = () => { if (!raf && ui) { last = performance.now() / 1000; raf = requestAnimationFrame(tick); } };
  const onPlay = () => {
    startAudio();
    if (audio?.ctx.state === 'suspended') audio.ctx.resume().catch(() => {});
    kick();
  };

  // ---- in Control room only ----
  function mount() {
    if (ui) return;
    const safe = h('<div class="cr-safe" aria-hidden="true"><i></i></div>');
    const meters = h('<div class="cr-meters" aria-hidden="true"><span class="cr-m"><i></i></span><span class="cr-m"><i></i></span></div>');
    ui = { safe, meters, bars: [...meters.children] };
    host.append(safe, meters);
    ro = new ResizeObserver(place); ro.observe(stage); ro.observe(host);
    place();
    els = media();
    for (const el of els) el.addEventListener('play', onPlay);
    if (els.some((el) => !el.paused)) onPlay();
  }
  function unmount() {
    if (!ui) return;
    cancelAnimationFrame(raf); raf = 0;
    ro?.disconnect(); ro = null;
    for (const el of els) el.removeEventListener('play', onPlay);
    els = [];
    stopAudio(); noAudio = false;
    ui.safe.remove(); ui.meters.remove(); ui = null;
    lv.fill(0); pk.fill(0);
  }
  const follow = (a) => (a.look === 'control' ? mount() : unmount());
  const off = onLook(follow);
  follow(currentLook());

  return { destroy() { off(); unmount(); } };
}
