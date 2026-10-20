// The recorder: Video Octopus records the screen, camera and mic itself, in Chrome or Edge on Windows or Mac, with
// nothing else to install. The browser asks for the camera and mic once and shows its own screen picker;
// one MediaRecorder per picture (screen + mic, camera + mic) or an AudioWorklet for a mic-only take sends a chunk
// about every second to Video Octopus (server/browser-recorder.mjs), which makes the usual take files when you stop.
import { $, esc, h, api, toast, isMac } from './ui.js';
import { scriptCard, prompterForTake, syncWithRecorder } from './prompter.js';

export const HOTKEY = isMac ? '⌥⌘R' : 'Ctrl+Alt+R';
export const isHotkey = (e) => e.code === 'KeyR' && e.altKey && !e.shiftKey && (isMac ? e.metaKey : e.ctrlKey);

// Test hook: ?fakeScreen=1 makes "Pick a screen" use a moving test picture instead of the browser's picker.
const FAKE_SCREEN = new URLSearchParams(location.search).has('fakeScreen');
// ?fakeScreen=refused: the screen fails the way a Mac without Screen Recording allowed answers (tests).
const SCREEN_REFUSED = new URLSearchParams(location.search).get('fakeScreen') === 'refused';
const MIMES = ['video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/mp4;codecs=avc1,opus', 'video/webm', 'video/mp4'];
const TIMESLICE = 1000;

// What this browser can do (Setup and the record panel say so when something is missing).
export function support() {
  const md = navigator.mediaDevices, missing = [];
  if (!md?.getUserMedia) missing.push('camera and microphone');
  if (!md?.getDisplayMedia) missing.push('screen recording');
  if (!window.MediaRecorder) missing.push('video recording (MediaRecorder)');
  if (!window.AudioWorkletNode) missing.push('mic-only recording (AudioWorklet)');
  const brands = navigator.userAgentData?.brands || [];
  const chromium = brands.some((b) => /Chromium|Google Chrome|Microsoft Edge/.test(b.brand));
  const mime = window.MediaRecorder ? MIMES.find((t) => MediaRecorder.isTypeSupported(t)) || '' : '';
  return { ok: !missing.length && Boolean(mime), missing, chromium, mime };
}
export const browserName = () => {
  const b = (navigator.userAgentData?.brands || []).map((x) => x.brand);
  return b.includes('Microsoft Edge') ? 'Edge' : b.includes('Google Chrome') ? 'Chrome' : b.some((x) => /Chromium/.test(x)) ? 'Chromium'
    : /Firefox\//.test(navigator.userAgent) ? 'Firefox' : /Safari\//.test(navigator.userAgent) ? 'Safari' : 'this browser';
};

// ---------- the session: one take at a time, for one project, kept while you move around the app ----------
const S = { phase: 'idle', project: null, take: null, startedAt: 0, progress: 0, kind: null };
const subs = new Set();
export const session = () => S;
export const onSession = (fn) => { subs.add(fn); return () => subs.delete(fn); };
const set = (patch) => { Object.assign(S, patch); for (const fn of subs) { try { fn(S); } catch (e) { console.error(e); } } };
syncWithRecorder(onSession); // a script in its own window follows the take
let run = null;  // the running take: recorders, uploaders, streams
let dev = null;  // the open streams: { screen, cam, mic } (MediaStream or null)
window.addEventListener('beforeunload', (e) => { if (['starting', 'recording', 'stopping'].includes(S.phase)) { e.preventDefault(); e.returnValue = ''; } });

export const stopStream = (s) => s?.getTracks().forEach((t) => t.stop());
// The record panel's mic level runs with the streams it reads (d.meter: its AudioContext and drawing loop).
function meterOff(d) { if (!d?.meter) return; cancelAnimationFrame(d.meter.raf); d.meter.ctx.close().catch(() => {}); d.meter = null; }
function closeDevices(d = dev) { if (!d) return; meterOff(d); stopStream(d.screen); stopStream(d.cam); stopStream(d.mic); if (d === dev) dev = null; }
const label = (s) => s?.getTracks()[0]?.label || '';

// Creator-quality voice: no echo cancelling, noise suppression or auto gain; 48 kHz when the mic can.
const micC = (id) => ({ ...(id && id !== 'default' ? { deviceId: { exact: id } } : {}), echoCancellation: false, noiseSuppression: false, autoGainControl: false, sampleRate: { ideal: 48000 } });
const camC = (id) => ({ ...(id && id !== 'default' ? { deviceId: { exact: id } } : {}), width: { ideal: 1920 }, height: { ideal: 1080 }, frameRate: { ideal: 30 } });

// One getUserMedia for both (one permission prompt); a remembered device that's gone falls back to the default.
async function openUser(cam, mic) {
  const want = { video: cam && cam !== 'none' ? camC(cam) : false, audio: mic && mic !== 'none' ? micC(mic) : false };
  if (!want.video && !want.audio) return { cam: null, mic: null };
  let s;
  try { s = await navigator.mediaDevices.getUserMedia(want); }
  catch (e) {
    if (e.name !== 'OverconstrainedError' && e.name !== 'NotFoundError') throw e;
    s = await navigator.mediaDevices.getUserMedia({ video: want.video && camC(null), audio: want.audio && micC(null) });
  }
  const v = s.getVideoTracks(), a = s.getAudioTracks();
  return { cam: v.length ? new MediaStream(v) : null, mic: a.length ? new MediaStream(a) : null };
}

function fakeScreen() {
  const c = Object.assign(document.createElement('canvas'), { width: 1280, height: 720 });
  const g = c.getContext('2d'), t0 = performance.now();
  const draw = () => {
    const t = (performance.now() - t0) / 1000;
    g.fillStyle = '#1d2533'; g.fillRect(0, 0, 1280, 720);
    g.fillStyle = '#f97316'; g.fillRect((t * 240) % 1280, 300, 120, 120);
    g.fillStyle = '#fff'; g.font = '48px sans-serif'; g.fillText(`Test screen ${t.toFixed(1)} s`, 40, 80);
  };
  draw();
  const timer = setInterval(draw, 1000 / 30);
  const s = c.captureStream(30);
  const tr = s.getVideoTracks()[0];
  Object.defineProperty(tr, 'label', { value: 'Test screen (fakeScreen=1)' });
  const stop = tr.stop.bind(tr);
  tr.stop = () => { clearInterval(timer); stop(); };
  return s;
}

// The browser's own picker (it appears every time; nothing is chosen for you). The screen at its own resolution
// (a Mac's built-in Retina screen and 4K monitors in full; only bigger ones are scaled to fit 3840 × 2400), 30 fps.
async function pickScreen() {
  if (SCREEN_REFUSED) throw new DOMException('Could not start video source', 'NotReadableError');
  if (FAKE_SCREEN) return fakeScreen();
  return navigator.mediaDevices.getDisplayMedia({
    video: { frameRate: { ideal: 30, max: 30 }, cursor: 'always', width: { max: 3840 }, height: { max: 2400 } },
    audio: false, surfaceSwitching: 'exclude', monitorTypeSurfaces: 'include',
  });
}

// What went wrong, in words, with where to allow it (the browser's site settings, and on a Mac System Settings).
function permText(e, what) {
  const mac = isMac ? ` On a Mac, also check System Settings → Privacy & Security → ${what === 'screen' ? 'Screen & System Audio Recording' : 'Camera and Microphone'} and switch ${browserName()} on (then restart ${browserName()}).` : '';
  if (e?.name === 'NotAllowedError') return what === 'screen'
    ? (/system/i.test(e.message) ? `Your computer didn't let ${browserName()} record the screen.${mac}` : 'No screen picked.')
    : `${browserName()} blocked the ${what}. Click the camera icon (or the lock) in the address bar, set Camera and Microphone to Allow for Video Octopus, then press Try again.${mac}`;
  if (e?.name === 'NotFoundError') return `No ${what} found. Plug one in, then press Try again.`;
  // A Mac without Screen Recording allowed for the browser answers "Could not start video source" too.
  if (e?.name === 'NotReadableError' && what === 'screen') return isMac
    ? `${browserName()} couldn't record the screen. Check System Settings → Privacy & Security → Screen & System Audio Recording and switch ${browserName()} on, then quit and reopen ${browserName()}. If it's on already, another app may be holding the screen: close it, then press Try again.`
    : 'The screen is busy: another app may be recording it. Close it, then press Try again.';
  if (e?.name === 'NotReadableError') return `The ${what} is busy: another app (a video call, OBS, another recorder) may be using it. Close it, then press Try again.`;
  return `Couldn't open the ${what}: ${e?.message || e}`;
}

// ---------- recording ----------
function pickMime() { return MIMES.find((t) => MediaRecorder.isTypeSupported(t)) || ''; }
const fmt = (s) => s ? JSON.parse(JSON.stringify(s.getTracks()[0]?.getSettings?.() || {}, ['width', 'height', 'frameRate', 'sampleRate', 'channelCount', 'echoCancellation', 'noiseSuppression', 'autoGainControl', 'displaySurface'])) : undefined;

// Chunks go up one at a time per track, in order; a failed post is tried again (Video Octopus restarting, a busy disk),
// and the take keeps recording meanwhile.
function uploader(url) {
  let seq = 0, busy = false, fails = 0, hardFails = 0;
  const q = [], waiters = [];
  const uploads = {
    sent: 0, error: null,
    push(blob) { if (blob?.size) { q.push({ seq: seq++, blob }); pump(); } },
    drain: () => (q.length || busy ? new Promise((r) => waiters.push(r)) : Promise.resolve()),
    pending: () => q.reduce((s, c) => s + c.blob.size, 0),
  };
  async function pump() {
    if (busy) return;
    busy = true;
    while (q.length && !uploads.error) {
      const c = q[0];
      try {
        const r = await fetch(`${url}&seq=${c.seq}`, { method: 'POST', headers: { 'X-Studio': '1', 'Content-Type': 'application/octet-stream' }, body: c.blob });
        if (!r.ok) {
          const j = await r.json().catch(() => ({}));
          const err = new Error(j.error || `HTTP ${r.status}`);
          if (r.status >= 400 && r.status < 500 && ++hardFails >= 5) uploads.error = err;
          throw err;
        }
        q.shift(); uploads.sent += c.blob.size; fails = 0; hardFails = 0;
      } catch (e) {
        fails++;
        if (fails === 3) toast(`Can't reach Video Octopus to save the take (${e.message}). Still recording; trying again…`);
        await new Promise((r) => setTimeout(r, Math.min(5000, 400 * fails)));
      }
    }
    busy = false;
    while (waiters.length) waiters.shift()();
  }
  return uploads;
}

// Start: Video Octopus makes the take folder, then every recorder starts on the same tick; each one's actual start
// (onstart) goes to Video Octopus so it can line the files up.
async function startTake(id, d, sel) {
  const kind = recordWhat(sel);
  const base = `/api/projects/${encodeURIComponent(id)}`;
  const mime = pickMime();
  const mic = d.mic?.getAudioTracks()[0] || null;
  const tracks = {};
  if (kind === 'screen') { tracks.screen = { mime }; if (d.cam) tracks.webcam = { mime }; }
  if (kind === 'camera') tracks.webcam = { mime };
  let ctx = null, node = null;
  try {
    if (kind === 'mic') {
      // 48 kHz whatever the mic runs at (the browser resamples); its own channel count, at most two.
      ctx = new AudioContext({ sampleRate: 48000 });
      await ctx.audioWorklet.addModule('/rec-worklet.js');
      const channels = Math.min(2, Math.max(1, mic.getSettings().channelCount || 1));
      node = new AudioWorkletNode(ctx, 'studio-pcm', { numberOfInputs: 1, numberOfOutputs: 1, channelCount: channels, channelCountMode: 'explicit', processorOptions: { channels } });
      ctx.createMediaStreamSource(d.mic).connect(node);
      node.connect(ctx.destination); // it outputs silence; being connected keeps it running
      tracks.audio = { rate: ctx.sampleRate, channels };
    }
    const r = await api(`${base}/rec-start`, {
      kind, target: sel.target, tracks, userAgent: navigator.userAgent,
      choices: { screen: kind === 'screen' ? 'screen' : 'none', camera: d.cam ? sel.camera : 'none', mic: d.mic ? sel.mic : 'none', countdown: sel.countdown },
      devices: { screen: label(d.screen), camera: label(d.cam), mic: label(d.mic) },
      settings: { mime, screen: fmt(d.screen), camera: fmt(d.cam), mic: fmt(d.mic) },
    });
    const take = r.take;
    const R = { id, take, kind, recs: [], ups: {}, timing: {}, ctx, node, d, stopped: false };
    const up = (k) => (R.ups[k] = uploader(`${base}/rec-chunk?take=${encodeURIComponent(take)}&track=${k}`));
    if (kind === 'mic') {
      const u = up('audio');
      let bufs = [], n = 0;
      const flush = () => { if (bufs.length) u.push(new Blob(bufs)); bufs = []; n = 0; };
      R.audioDone = new Promise((done) => {
        node.port.onmessage = (e) => {
          if (e.data.pcm) { bufs.push(e.data.pcm); n += e.data.pcm.length; if (n >= 48000 * tracks.audio.channels) flush(); }
          if (e.data.done) { flush(); done(); }
        };
      });
      if (ctx.state !== 'running') await ctx.resume();
      R.timing.audio = { start: performance.now() };
      node.port.postMessage('start');
    } else {
      const make = (k, stream, bits) => {
        const mr = new MediaRecorder(stream, { mimeType: mime || undefined, videoBitsPerSecond: bits, audioBitsPerSecond: 256000 });
        const u = up(k);
        R.timing[k] = {};
        mr.ondataavailable = (e) => u.push(e.data);
        mr.onstart = () => { R.timing[k].start = performance.now(); };
        mr.onerror = (e) => { console.error('MediaRecorder', e.error || e); toast(`The recorder stopped (${e.error?.message || 'error'}). Saving what's there.`); stop(); };
        R.recs.push({ k, mr, stopped: new Promise((done) => { mr.onstop = done; }) });
        return mr;
      };
      const area = (s) => { const st = s.getVideoTracks()[0]?.getSettings() || {}; return (st.width || 1920) * (st.height || 1080); };
      // ~10 Mbps for a 1080p screen (more for bigger ones), ~6 Mbps for the camera, 256 kbps for the voice.
      const screenBits = d.screen ? Math.round(Math.min(25e6, 10e6 * Math.max(1, area(d.screen) / (1920 * 1080)))) : 0;
      const list = [];
      if (tracks.screen) list.push(make('screen', new MediaStream([...d.screen.getVideoTracks(), ...(mic ? [mic] : [])]), screenBits));
      if (tracks.webcam) list.push(make('webcam', new MediaStream([...d.cam.getVideoTracks(), ...(mic ? [mic] : [])]), 6e6));
      for (const mr of list) mr.start(TIMESLICE); // the same tick
    }
    // Any source ending (Stop sharing in the browser bar, a camera unplugged) ends the take cleanly.
    for (const s of [d.screen, d.cam, d.mic]) for (const t of s?.getTracks() || []) t.addEventListener('ended', () => {
      if (run === R && S.phase === 'recording') { toast(t.kind === 'video' && s === d.screen ? 'Screen sharing stopped: saving the take.' : `The ${t.kind === 'audio' ? 'microphone' : 'camera'} went away: saving the take.`); stop(); }
    });
    run = R;
    set({ phase: 'recording', project: id, take, startedAt: Date.now(), progress: 0, kind });
    return take;
  } catch (e) { ctx?.close().catch(() => {}); throw e; } // a mic-only take that didn't start lets go of its AudioContext
}

// Stop: the last chunks go up, then Video Octopus makes the take files (progress shows on the button).
export async function stop() {
  const R = run;
  if (!R || R.stopped) return;
  R.stopped = true;
  set({ phase: 'stopping' });
  const at = performance.now();
  for (const k of Object.keys(R.timing)) R.timing[k].stop = at;
  if (R.node) { R.node.port.postMessage('stop'); await Promise.race([R.audioDone, new Promise((r) => setTimeout(r, 2000))]); }
  for (const x of R.recs) { try { if (x.mr.state !== 'inactive') x.mr.stop(); } catch {} }
  await Promise.all(R.recs.map((x) => x.stopped));
  closeDevices(R.d); // the camera light goes off now
  R.ctx?.close().catch(() => {});
  await Promise.all(Object.values(R.ups).map((u) => u.drain()));
  const failed = Object.values(R.ups).find((u) => u.error);
  if (failed) { set({ phase: 'idle' }); run = null; return toast(`Couldn't save the take: ${failed.error.message}. What arrived is kept; reopen the project to finish it.`); }
  try {
    await api(`/api/projects/${encodeURIComponent(R.id)}/rec-finish`, { take: R.take, timing: R.timing });
    set({ phase: 'saving', progress: 0 });
    watchSave(R.id, R.take);
  } catch (e) { toast(e.message); set({ phase: 'idle' }); }
  run = null;
}

// The save runs in Video Octopus; the button follows it (the project page also shows it as a job).
function watchSave(id, take) {
  const tick = async () => {
    let st = null;
    try { st = await api(`/api/projects/${encodeURIComponent(id)}/rec-status?take=${encodeURIComponent(take)}`); } catch {}
    if (S.take !== take) return;
    if (st?.done) { if (!st.ok) toast(st.error || 'Couldn’t save the take.'); return set({ phase: 'idle', progress: 0, take: null }); }
    if (st) set({ progress: st.progress || 0 });
    setTimeout(tick, 700);
  };
  setTimeout(tick, 400);
}

// Finish a take whose page closed mid-take (the parts stayed in the recordings folder).
export async function recover(id, take) {
  await api(`/api/projects/${encodeURIComponent(id)}/rec-finish`, { take, recover: true });
  if (S.phase === 'idle') { set({ phase: 'saving', progress: 0, project: id, take, kind: null }); watchSave(id, take); }
}

// ---------- the record panel ----------
let panelOpen = null; // { start() } while the panel is up, for the hotkey
let opening = false; // the panel is asking Video Octopus for the project (a second press does nothing meanwhile)
export const panelIsOpen = () => Boolean(panelOpen);
export const startFromPanel = () => panelOpen?.start();
export const closePanel = () => panelOpen?.close();

// choices: what Settings → Recording remembers ({ screen, camera, mic, target, countdown }, P.recorder);
// P: the project; opts.target/label: a block.
export async function recordPanel({ id, P, choices, opts = {}, settingsLink }) {
  if (S.phase !== 'idle') return toast('A take is still recording or saving.');
  if (opening || panelOpen) return;
  const sup = support();
  const ch = choices || {};
  // The project as Video Octopus has it now: a take that came in a moment ago (still making its playback copies) counts, so
  // "Where the take goes" shows. With no take shown there's no choice, and the new take is the take: never a layer the
  // creator didn't pick (Settings can remember "Add as a layer").
  opening = true;
  const fresh = await api(`/api/projects/${encodeURIComponent(id)}`).catch(() => null);
  opening = false;
  const cv = fresh?.canvas || P.canvas || {};
  const hasTake = Boolean(cv.screen || cv.cam || cv.audio);
  const sel = {
    display: ch.screen === 'none' ? 'none' : 'screen',
    camera: ch.camera || 'default', mic: ch.mic || 'default',
    target: /^block:/.test(opts.target || '') ? opts.target : hasTake && ch.target === 'layer' ? 'layer' : 'replace',
    countdown: [0, 3, 5].includes(ch.countdown) ? ch.countdown : 3,
  };
  const ly = P.layout || {};
  const camLeft = ly.preset === 'pip' ? (ly.webcam?.x ?? 1) < 0.5 : ly.side === 'left';
  const page = h(`<div class="rec-page" role="dialog" aria-modal="true" aria-labelledby="rpTitle">
    <header class="rp-bar">
      <button class="btn ghost" id="rBack"><svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true"><path d="M10 3L5 8l5 5"/></svg>Back to editor</button>
      <span class="rp-sep" aria-hidden="true">/</span><b id="rpTitle">${opts.label ? `Record the ${esc(opts.label)} block` : 'Record a take'}</b><span class="sub">into ${esc(P.name)}</span>
      <span class="gap"></span>
      <span class="rp-status"><span class="dot ${sup.ok ? 'ok' : 'warn'}" id="rDot"></span><span id="rStat">Recording in ${esc(browserName())}</span>
        <a href="${esc(settingsLink)}" class="rp-switch">Recorder settings</a></span>
    </header>
    <div class="rp-body">
      <section class="rp-preview" aria-label="Live preview">
        <div class="rp-stage">
          <div class="rp-frame">
            <video id="pvScreen" muted playsinline autoplay aria-label="Preview of the picked screen"></video>
            <span class="rp-wait">Pick a screen to see it here.</span>
            <div class="rp-cam${camLeft ? ' left' : ''}" id="camBox"><video id="pvCam" muted playsinline autoplay aria-label="Live camera preview"></video></div>
            <span class="rp-live"><i></i>Live preview · not recording</span>
          </div>
        </div>
        <div class="rp-mic" id="micRow"><b>Mic</b><div class="rp-meter" id="meter" aria-hidden="true">${'<i></i>'.repeat(40)}</div><span class="sub" id="micHint">Say a sentence at your normal voice.</span>
          <span class="rp-micsug" id="micSug" hidden>You're on the computer's own mic, and <b id="micSugName"></b> is plugged in.<button type="button" class="btn small" id="micSugUse">Use it</button></span>
          <p class="rp-only" id="micOnly" hidden><b>Mic only</b> No screen and no camera: the take is a WAV of your voice (24-bit, unprocessed). Use it as the take, or as a block such as a voiceover sponsor read.</p></div>
      </section>
      <aside class="rp-side" aria-label="Setup">
        <div class="rp-card"><h3>Sources</h3>
          <div class="rp-f"><span id="scrL">Screen</span><div class="rp-scr" role="group" aria-labelledby="scrL"><span class="rp-scr-name" id="scrName"></span>
            <button type="button" class="btn small" id="scrPick">Pick a screen…</button><button type="button" class="btn ghost small" id="scrNone">No screen</button></div></div>
          <label class="rp-f"><span>Camera</span><select class="field" id="rCamera"><option value="none">No camera</option></select></label>
          <label class="rp-f"><span>Microphone</span><select class="field" id="rMic"><option value="none">No microphone</option></select></label>
        </div>
        <div class="rp-card rp-script" id="rScript" aria-label="Script"></div>
        <div class="rp-card"><h3>Options</h3>
          ${opts.label ? `<div class="rp-f"><span>Where the take goes</span><div class="sub">Into the block <b>${esc(opts.label)}</b>: it becomes that block's own file. The canvas take stays as it is.</div></div>`
            : hasTake ? `<div class="rp-f"><span id="tgtL">Where the take goes</span><div class="seg wide" id="rTarget" role="radiogroup" aria-labelledby="tgtL"><button role="radio" data-t="replace">Replace current take</button><button role="radio" data-t="layer">Add as a layer</button></div></div>` : ''}
          <div class="rp-f"><span id="cntL">Countdown</span><div class="seg wide" id="rCount" role="radiogroup" aria-labelledby="cntL"><button role="radio" data-c="0">Off</button><button role="radio" data-c="3">3 s</button><button role="radio" data-c="5">5 s</button></div></div>
        </div>
        <div class="notice" id="rPerm" hidden></div>
        ${sup.ok ? '' : `<div class="notice">${esc(browserName())} can't record everything here (${esc(sup.missing.join(', ') || 'no video format')}). Use Chrome or Edge on Windows or Mac.</div>`}
        <span class="gap"></span>
        <button class="rp-start" id="rStart"><span class="dot" aria-hidden="true"></span><span id="rStartL">Start recording</span></button>
        <p class="sub rp-hint">Or press <kbd>${HOTKEY}</kbd>. Stop with the Record button, <kbd>${HOTKEY}</kbd> in Video Octopus, or the browser's Stop sharing; the take comes straight into this project.</p>
      </aside>
    </div></div>`);
  document.body.append(page);
  scriptCard($('#rScript', page), id);
  const segs = () => {
    page.querySelectorAll('#rTarget button').forEach((x) => { const on = x.dataset.t === sel.target; x.classList.toggle('on', on); x.setAttribute('aria-checked', String(on)); });
    page.querySelectorAll('#rCount button').forEach((x) => { const on = Number(x.dataset.c) === sel.countdown; x.classList.toggle('on', on); x.setAttribute('aria-checked', String(on)); });
  };
  page.querySelectorAll('#rTarget button').forEach((x) => (x.onclick = () => { sel.target = x.dataset.t; segs(); }));
  page.querySelectorAll('#rCount button').forEach((x) => (x.onclick = () => { sel.countdown = Number(x.dataset.c); segs(); }));

  const d = { screen: null, cam: null, mic: null };
  dev = d;
  let open = true;
  const pvS = $('#pvScreen', page), pvC = $('#pvCam', page), frame = $('.rp-frame', page), camBox = $('#camBox', page);
  // Frame the camera the way the canvas does (zoom 1 = the whole camera height; focus = the point it zooms on).
  // With object-fit: cover, object-position f% puts the picture's point f on the box's point f, so zooming
  // around that point keeps the face in place. The box itself is mirrored in CSS, like looking in a mirror.
  const cam = ly.cam || {}, fx = cam.focus?.x ?? 0.5, fy = cam.focus?.y ?? 0.45, z = Math.max(1, cam.zoom || 1);
  Object.assign(pvC.style, { objectPosition: `${fx * 100}% ${fy * 100}%`, transformOrigin: `${fx * 100}% ${fy * 100}%`, transform: `scale(${z})` });
  let permFor = null; // what the note is about ('screen', or a camera/mic), so No screen can clear a screen note
  const perm = (text, retry, what = null) => {
    const n = $('#rPerm', page);
    permFor = text ? what : null;
    n.hidden = !text;
    n.replaceChildren(...(text ? [h(`<span>${esc(text)}</span>`)] : []));
    if (text && retry) { const btn = h('<button type="button" class="btn small">Try again</button>'); btn.onclick = retry; n.append(' ', btn); }
    $('#rDot', page).className = `dot ${text ? 'warn' : 'ok'}`;
  };

  const show = () => {
    pvS.srcObject = d.screen; pvC.srcObject = d.cam;
    frame.classList.toggle('live', Boolean(d.screen));
    camBox.classList.toggle('live', Boolean(d.cam));
    $('#scrName', page).textContent = sel.display === 'none' ? 'No screen (camera or mic only)' : d.screen ? label(d.screen) || 'Picked screen' : 'The browser asks which screen or window when you start, or pick it now.';
    $('#scrPick', page).textContent = d.screen ? 'Pick another…' : 'Pick a screen…';
    $('#scrNone', page).hidden = sel.display === 'none';
    camBox.hidden = sel.camera === 'none';
    $('#meter', page).hidden = sel.mic === 'none';
    if (sel.mic === 'none') $('#micHint', page).textContent = 'No microphone: the take will have no sound.';
    followChoices(page, sel);
    if (!d.screen && recordWhat(sel) === 'screen') $('.rp-wait', page).textContent = 'Pick a screen to see it here (or press Start: the browser asks then).';
    segs();
  };

  // Device lists: names need permission, which the first getUserMedia asks for.
  async function lists() {
    let all = [];
    try { all = await navigator.mediaDevices.enumerateDevices(); } catch {}
    const fill = (sel_, kind, cur, none, live) => {
      const list = all.filter((x) => x.kind === kind && x.deviceId !== 'communications');
      // No permission yet (or blocked): the browser hides the devices; keep the choice so Try again opens it.
      if (!list.some((x) => x.deviceId)) {
        const v = list.length || cur !== 'none' ? (cur === 'none' ? 'none' : cur) : 'none';
        sel_.innerHTML = `<option value="none">${none}</option>` + (list.length ? `<option value="${esc(v === 'none' ? 'default' : v)}">${kind === 'videoinput' ? 'Your camera' : 'Your microphone'} (names show once it's allowed)</option>` : '');
        sel_.value = v === 'none' ? 'none' : sel_.options[1]?.value || 'none';
        return sel_.value === 'none' ? 'none' : v;
      }
      const liveId = live?.getTracks()[0]?.getSettings().deviceId;
      const v = cur === 'none' ? 'none' : list.some((x) => x.deviceId === cur) ? cur : liveId || list[0]?.deviceId || 'none';
      sel_.innerHTML = `<option value="none">${none}</option>` + list.map((x, i) => `<option value="${esc(x.deviceId)}"${x.deviceId === v ? ' selected' : ''}>${esc((x.label || `${kind === 'videoinput' ? 'Camera' : 'Microphone'} ${i + 1}`).replace(/\s*\([0-9a-f]{4}:[0-9a-f]{4}\)$/i, ''))}</option>`).join('');
      sel_.value = v;
      return v;
    };
    sel.camera = fill($('#rCamera', page), 'videoinput', sel.camera, 'No camera', d.cam);
    sel.mic = fill($('#rMic', page), 'audioinput', sel.mic, 'No microphone', d.mic);
    // The computer's own mic in use (often just the system default) while a USB or XLR mic is plugged in: offer it.
    const builtIn = (x) => /built-?in|macbook|internal|microphone array/i.test(x?.label || '');
    const inUse = sel.mic === 'none' ? null : all.find((x) => x.kind === 'audioinput' && x.deviceId === sel.mic);
    const ext = all.find((x) => x.kind === 'audioinput' && x.label && !['default', 'communications', ''].includes(x.deviceId) && !builtIn(x)
      && !/iphone|ipad|continuity|virtual|blackhole|loopback|zoom|teams|soundflower/i.test(x.label));
    const sug = $('#micSug', page);
    sug.hidden = !(inUse && builtIn(inUse) && ext);
    if (!sug.hidden) { $('#micSugName', page).textContent = ext.label.replace(/\s*\([0-9a-f]{4}:[0-9a-f]{4}\)$/i, ''); sug.dataset.id = ext.deviceId; }
  }
  const asked = { cam: 0, mic: 0 }; // only the newest pick of each device counts (quick changes)
  // Opens still on their way (a camera or mic just picked): Start waits for them rather than calling them missing.
  const devOpens = new Set();
  function openDevs(which = 'both') {
    const job = openDevsNow(which);
    devOpens.add(job); job.finally(() => devOpens.delete(job)).catch(() => {});
    return job;
  }
  async function openDevsNow(which) {
    perm('');
    const tok = { cam: which !== 'mic' ? ++asked.cam : 0, mic: which !== 'cam' ? ++asked.mic : 0 };
    try {
      const r = await openUser(which !== 'mic' ? sel.camera : 'none', which !== 'cam' ? sel.mic : 'none');
      // Closed while the browser asked: let go of what it opened (close() already let go of the rest).
      if (!open) { stopStream(r.cam); stopStream(r.mic); return; }
      if (tok.cam && tok.cam === asked.cam) { stopStream(d.cam); d.cam = r.cam; } else stopStream(r.cam);
      if (tok.mic && tok.mic === asked.mic) { stopStream(d.mic); d.mic = r.mic; meterOn(); } else stopStream(r.mic);
    } catch (e) { if (open) perm(permText(e, which === 'mic' ? 'microphone' : which === 'cam' ? 'camera' : 'camera and microphone'), () => openDevs(which)); }
    if (!open) return;
    await lists();
    show();
  }

  // Mic level: the loudest sample of each frame in dBFS, 40 segments from -60 to 0 dB.
  const segsEl = [...page.querySelectorAll('#meter i')];
  function meterOn() {
    meterOff(d);
    if (!d.mic || !open) return;
    const m = d.meter = { ctx: new AudioContext(), raf: 0 };
    const an = m.ctx.createAnalyser();
    an.fftSize = 2048;
    m.ctx.createMediaStreamSource(d.mic).connect(an);
    const buf = new Float32Array(an.fftSize), recent = [];
    const loop = () => {
      if (d.meter !== m) return; // turned off
      an.getFloatTimeDomainData(buf);
      let pk = 0; for (const v of buf) pk = Math.max(pk, Math.abs(v));
      const db = 20 * Math.log10(pk || 1e-6), l = Math.max(0, Math.min(1, (db + 60) / 60));
      const n = Math.round(l * segsEl.length);
      segsEl.forEach((s, i) => (s.className = i < n ? (i < 28 ? 'g' : i < 35 ? 'a' : 'r') : ''));
      recent.push(db); if (recent.length > 120) recent.shift();
      const top = Math.max(...recent);
      if (sel.mic !== 'none') $('#micHint', page).textContent = top > -3 ? 'Too loud: turn the input down or sit a little further back.' : top > -30 ? 'Good level.' : 'Say a sentence at your normal voice.';
      m.raf = requestAnimationFrame(loop);
    };
    loop();
  }

  async function screen() {
    try {
      const s = await pickScreen();
      if (!open) { stopStream(s); return false; } // closed while the picker was up
      stopStream(d.screen);
      d.screen = s;
      sel.display = 'screen';
      s.getVideoTracks()[0].addEventListener('ended', () => { if (open && d.screen === s) { d.screen = null; show(); } });
      perm('');
    } catch (e) { if (e.name !== 'NotAllowedError' || /system/i.test(e.message)) perm(permText(e, 'screen'), () => screen(), 'screen'); }
    show();
    return Boolean(d.screen);
  }
  $('#scrPick', page).onclick = () => screen();
  $('#scrNone', page).onclick = () => { stopStream(d.screen); d.screen = null; sel.display = 'none'; if (permFor === 'screen') perm(''); show(); };
  $('#rCamera', page).onchange = (e) => { sel.camera = e.target.value; perm(''); stopStream(d.cam); d.cam = null; show(); if (sel.camera !== 'none') openDevs('cam'); };
  $('#micSugUse', page).onclick = () => { const m = $('#rMic', page); m.value = $('#micSug', page).dataset.id; m.onchange({ target: m }); };
  $('#rMic', page).onchange = (e) => { sel.mic = e.target.value; perm(''); stopStream(d.mic); d.mic = null; meterOn(); show(); if (sel.mic !== 'none') openDevs('mic'); };
  const devChange = () => { if (open) lists().then(show); };
  navigator.mediaDevices?.addEventListener?.('devicechange', devChange);

  const close = (keep = false) => {
    open = false; panelOpen = null;
    meterOff(d);
    navigator.mediaDevices?.removeEventListener?.('devicechange', devChange);
    document.removeEventListener('keydown', onKey);
    pvS.srcObject = null; pvC.srcObject = null;
    page.remove();
    if (!keep) closeDevices(d);
  };
  const onKey = (e) => { if (e.key === 'Escape') close(); };
  document.addEventListener('keydown', onKey);
  $('#rBack', page).onclick = () => close();
  $('.rp-switch', page).onclick = () => close(); // then the link opens Settings → Recording
  let pressed = false; // one Start at a time (a second press while the first waits does nothing)
  const start = async () => {
    if (pressed) return;
    pressed = true;
    try { await startNow(); } finally { pressed = false; }
  };
  const startNow = async () => {
    const k = recordWhat(sel);
    if (!k || !sup.ok) return;
    if (k === 'screen' && !d.screen && !(await screen())) return; // the picker comes up on Start
    if (devOpens.size) {
      $('#rStartL', page).textContent = 'Opening the camera and mic…';
      await Promise.race([Promise.allSettled([...devOpens]), new Promise((r) => setTimeout(r, 8000))]);
      if (!open) return;
      $('#rStartL', page).textContent = recordLabel(sel);
    }
    // A camera or mic that's picked but didn't open: say so (the permission note, if any, stays).
    const note = $('#rPerm', page);
    if (!note.hidden && permFor === 'screen' && k !== 'screen') perm(''); // a screen note doesn't hold up a take without it
    if (!note.hidden) { note.classList.remove('flash'); void note.offsetWidth; note.classList.add('flash'); return; } // say why nothing starts
    if (k !== 'mic' && sel.camera !== 'none' && !d.cam) return perm(permText({ name: 'NotFoundError' }, 'camera'), () => openDevs('cam'));
    if (sel.mic !== 'none' && !d.mic) return perm(permText({ name: 'NotFoundError' }, 'microphone'), () => openDevs('mic'));
    close(true);
    prompterForTake(id, { onSession, stop }); // the script, if there is one, scrolls once the take starts
    set({ phase: 'starting', project: id });
    if (sel.countdown && !(await countdown(sel.countdown))) { closeDevices(d); return set({ phase: 'idle' }); }
    try { await startTake(id, d, sel); }
    catch (e) { closeDevices(d); set({ phase: 'idle' }); toast(`Couldn't start recording: ${e.message}`); }
  };
  $('#rStart', page).onclick = start;
  panelOpen = { start, close: () => close() };
  show();
  if (!sup.ok) return;
  await openDevs();
}

// ---------- what the panel's choices record ----------
// What a press records with the record panel's choices: 'screen' (with or without the camera), 'camera' or 'mic';
// null = nothing chosen.
export function recordWhat(sel) {
  if (sel.display !== 'none') return 'screen';
  if (sel.camera !== 'none') return 'camera';
  return sel.mic !== 'none' ? 'mic' : null;
}
function recordLabel(sel) {
  const k = recordWhat(sel);
  if (!k) return 'Pick something to record';
  return { screen: sel.camera !== 'none' ? 'Record screen + camera' : 'Record screen', camera: 'Record camera', mic: 'Record mic only' }[k];
}
// The record panel follows the choices: camera only = the camera fills the preview; mic only = a big mic meter and
// no picture, and "Add as a layer" (needs a picture) hides.
function followChoices(page, sel) {
  const k = recordWhat(sel);
  $('.rp-frame', page).classList.toggle('cam-only', k === 'camera');
  $('.rp-frame', page).classList.toggle('nothing', !k);
  $('.rp-preview', page).classList.toggle('mic-only', k === 'mic');
  $('#micOnly', page).hidden = k !== 'mic';
  const layerBtn = page.querySelector('#rTarget [data-t=layer]');
  if (layerBtn) { layerBtn.hidden = k === 'mic'; if (k === 'mic' && sel.target === 'layer') sel.target = 'replace'; }
  $('#rStart', page).disabled = !k;
  $('#rStartL', page).textContent = recordLabel(sel);
  $('.rp-wait', page).textContent = !k ? 'Pick a screen, a camera or a microphone.' : k === 'camera' ? 'Starting the camera preview…' : 'Starting the preview…';
}

// Big 3-2-1 over the app. Resolves false if cancelled.
function countdown(n) {
  return new Promise((done) => {
    const el = h(`<div class="countdown"><div class="num"></div><div class="sub">Recording starts… switch to what you want to record.</div><button class="btn small">Cancel</button></div>`);
    document.body.append(el);
    let left = n, t = 0;
    const finish = (ok) => { clearTimeout(t); el.remove(); done(ok); };
    $('button', el).onclick = () => finish(false);
    const tick = () => { if (left <= 0) return finish(true); $('.num', el).textContent = left; left -= 1; t = setTimeout(tick, 1000); };
    tick();
  });
}

// For tests (headless Chromium with fake devices): the running take's streams.
window.__studioRec = { session, streams: () => run?.d || dev, stop };
