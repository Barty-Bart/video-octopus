// The recorder: Video Octopus records the screen, camera and mic itself, in Chrome or Edge on Windows or Mac, with
// nothing else to install. The browser asks for the camera and mic once and shows its own screen picker;
// one MediaRecorder per picture (screen + mic, camera + mic) or an AudioWorklet for a mic-only take sends a chunk
// about every second to Video Octopus (server/browser-recorder.mjs), which makes the usual take files when you stop.
//
// While a take records, a small control bar (recorder.css) shows the time with Pause/Resume, Restart and Stop; when the
// script scrolls in Video Octopus the bar sits in the script's own bar instead. Restart asks once, in the bar, before it
// drops the take: the dropped take goes to the studio's trash and never becomes a take, and a new one starts after a
// 3-second countdown with the same screen, camera and mic. After a take is saved the bar offers Delete take, which
// moves it to the studio's trash (with Undo); see server/browser-recorder.mjs for what is refused.
import { $, esc, h, api, toast, isMac } from './ui.js';
import { scriptCard, prompterForTake, syncWithRecorder } from './prompter.js';

export const HOTKEY = isMac ? '⌥⌘R' : 'Ctrl+Alt+R';
export const isHotkey = (e) => e.code === 'KeyR' && e.altKey && !e.shiftKey && (isMac ? e.metaKey : e.ctrlKey);
// While recording: pause/resume and restart. The same modifiers as the Record key, so they don't reach the editor's
// own keys (Space, Z, the timeline's) or the script's (which ignore any modifier).
export const PAUSE_KEY = isMac ? '⌥⌘P' : 'Ctrl+Alt+P';
export const RESTART_KEY = isMac ? '⇧⌥⌘R' : 'Ctrl+Alt+Shift+R';
export const isPauseKey = (e) => e.code === 'KeyP' && e.altKey && !e.shiftKey && (isMac ? e.metaKey : e.ctrlKey);
export const isRestartKey = (e) => e.code === 'KeyR' && e.altKey && e.shiftKey && (isMac ? e.metaKey : e.ctrlKey);
const RESTART_COUNTDOWN = 3;

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
// startedAt: when the take would have started had it never paused, so the time recorded is always Date.now() - startedAt
// (while paused it is kept sliding, so anything showing that time stands still).
const S = { phase: 'idle', project: null, take: null, startedAt: 0, progress: 0, kind: null, paused: false };
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
  let seq = 0, busy = false, fails = 0, hardFails = 0, cancelled = false;
  const q = [], waiters = [];
  const uploads = {
    sent: 0, error: null,
    push(blob) { if (blob?.size && !cancelled) { q.push({ seq: seq++, blob }); pump(); } },
    // Restart: nothing more goes up for this take (what's queued is dropped with it).
    cancel() { cancelled = true; q.length = 0; },
    drain: () => (q.length || busy ? new Promise((r) => waiters.push(r)) : Promise.resolve()),
    pending: () => q.reduce((s, c) => s + c.blob.size, 0),
  };
  async function pump() {
    if (busy) return;
    busy = true;
    while (q.length && !uploads.error && !cancelled) {
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
        if (cancelled) break;
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
    const R = { id, take, kind, recs: [], ups: {}, timing: {}, ctx, node, d, sel, stopped: false, paused: false, pausedMs: 0 };
    const up = (k) => (R.ups[k] = uploader(`${base}/rec-chunk?take=${encodeURIComponent(take)}&track=${k}`));
    if (kind === 'mic') {
      const u = up('audio');
      let bufs = [], n = 0;
      const flush = () => { if (bufs.length) u.push(new Blob(bufs)); bufs = []; n = 0; };
      R.audioDone = new Promise((done) => {
        node.port.onmessage = (e) => {
          if (e.data.pcm && !R.paused && !R.discarded) { bufs.push(e.data.pcm); n += e.data.pcm.length; if (n >= 48000 * tracks.audio.channels) flush(); }
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
        mr.ondataavailable = (e) => { if (!R.discarded) u.push(e.data); };
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
    set({ phase: 'recording', project: id, take, startedAt: Date.now(), progress: 0, kind, paused: false });
    return take;
  } catch (e) { ctx?.close().catch(() => {}); throw e; } // a mic-only take that didn't start lets go of its AudioContext
}

// Stop: the last chunks go up, then Video Octopus makes the take files (progress shows on the button).
export async function stop() {
  const R = run;
  if (!R || R.stopped) return;
  R.stopped = true;
  endPause(R);
  set({ phase: 'stopping', paused: false });
  // The time spent paused isn't in the files: the take's length leaves it out too.
  const at = performance.now() - R.pausedMs;
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
    if (st?.done) {
      if (!st.ok) toast(st.error || 'Couldn’t save the take.');
      else afterTake(id, take);
      return set({ phase: 'idle', progress: 0, take: null });
    }
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

// ---------- pause, resume, restart ----------
// Pause: every recorder pauses (the files carry no gap: they continue where they paused), the time stands still and
// the script pauses with it. Video Octopus hears about it every couple of seconds, so a long pause isn't mistaken
// for a closed page.
const projectApi = (id, what) => `/api/projects/${encodeURIComponent(id)}/${what}`;
function sayPaused(R, paused) { api(projectApi(R.id, 'rec-pause'), { take: R.take, paused }).catch(() => {}); }

export function pause() {
  const R = run;
  if (!R || R.stopped || R.paused || S.phase !== 'recording') return;
  R.paused = true;
  R.pauseAt = performance.now();
  R.frozen = Date.now() - S.startedAt;
  for (const x of R.recs) { try { if (x.mr.state === 'recording') x.mr.pause(); } catch {} }
  // Keep the time still for everything that shows Date.now() - startedAt (the Record button too).
  R.freeze = setInterval(() => { S.startedAt = Date.now() - R.frozen; }, 200);
  R.beat = setInterval(() => sayPaused(R, true), 2000);
  sayPaused(R, true);
  set({ paused: true });
}

// The pause ends (Resume, Stop or Restart): the time paused is counted out of the take's length.
function endPause(R) {
  if (!R.paused) return false;
  clearInterval(R.freeze); clearInterval(R.beat);
  R.pausedMs += performance.now() - R.pauseAt;
  S.startedAt = Date.now() - R.frozen;
  R.paused = false;
  return true;
}

export function resume() {
  const R = run;
  if (!R || R.stopped || !R.paused) return;
  endPause(R);
  for (const x of R.recs) { try { if (x.mr.state === 'paused') x.mr.resume(); } catch {} }
  sayPaused(R, false);
  set({ paused: false });
}
export const togglePause = () => (run?.paused ? resume() : pause());

// Restart: the take being recorded is dropped (Video Octopus moves it to the studio's trash; it never becomes a take),
// then after a short countdown a new one starts with the same screen, camera and mic.
export async function restart() {
  const R = run;
  if (!R || R.stopped || S.phase !== 'recording') return;
  R.stopped = true;
  R.discarded = true;
  endPause(R);
  ui.confirm = false;
  set({ phase: 'starting', paused: false, restarting: true });
  for (const u of Object.values(R.ups)) u.cancel();
  if (R.node) { try { R.node.port.postMessage('stop'); } catch {} }
  for (const x of R.recs) { try { if (x.mr.state !== 'inactive') x.mr.stop(); } catch {} }
  await Promise.race([Promise.all(R.recs.map((x) => x.stopped)), new Promise((r) => setTimeout(r, 2000))]);
  R.ctx?.close().catch(() => {});
  run = null;
  try { await api(projectApi(R.id, 'rec-discard'), { take: R.take }); }
  catch (e) { toast(`Couldn't drop the take (${e.message}). It may show as an unsaved take: dismiss it there.`); }
  set({ take: null });
  if (!(await countdown(RESTART_COUNTDOWN, 'Starting again… the last take was discarded.'))) {
    closeDevices(R.d);
    set({ phase: 'idle', restarting: false });
    return toast('Restart cancelled: nothing is recording. The dropped take is in the studio’s trash.');
  }
  // A source that went away during the countdown (Stop sharing): say so rather than record without it.
  const gone = [R.d.screen, R.d.cam, R.d.mic].some((s) => s?.getTracks().some((t) => t.readyState === 'ended'));
  if (gone) { closeDevices(R.d); set({ phase: 'idle', restarting: false }); return toast('A screen, camera or mic went away, so the new take didn’t start. Press Record to set it up again.'); }
  try { await startTake(R.id, R.d, R.sel); set({ restarting: false }); }
  catch (e) { closeDevices(R.d); set({ phase: 'idle', restarting: false }); toast(`Couldn't start recording: ${e.message}`); }
}

// Restart asks once, in the bar: "Restart? This take will be discarded." Pressing Restart (or its key) again confirms;
// it goes back to the plain bar after a few seconds.
const ui = { confirm: false, confirmT: 0, after: null };
export function askRestart() {
  if (!run || run.stopped || S.phase !== 'recording') return;
  if (ui.confirm) return restart();
  ui.confirm = true;
  clearTimeout(ui.confirmT);
  ui.confirmT = setTimeout(() => { ui.confirm = false; renderCtl(); }, 6000);
  renderCtl();
}
const cancelRestart = () => { ui.confirm = false; clearTimeout(ui.confirmT); renderCtl(); };

document.addEventListener('keydown', (e) => {
  if (!run || run.stopped || S.phase !== 'recording') return;
  if (isPauseKey(e)) { e.preventDefault(); e.stopPropagation(); togglePause(); }
  else if (isRestartKey(e)) { e.preventDefault(); e.stopPropagation(); askRestart(); }
  else if (e.key === 'Escape' && ui.confirm) { e.preventDefault(); e.stopPropagation(); cancelRestart(); }
}, true);

// ---------- after a take: Delete take, with Undo ----------
function afterTake(id, take) {
  clearTimeout(ui.afterT);
  ui.after = { id, take, mode: 'saved' };
  ui.afterT = setTimeout(() => { if (ui.after?.take === take && ui.after.mode === 'saved') { ui.after = null; renderCtl(); } }, 15000);
  renderCtl();
}

// Moves the take to the studio's trash and out of its project (the project goes back to its take before). Returns the
// server's answer, or throws with why it was refused (another project uses it, it's already transcribed or cut…).
export async function deleteTake(id, take) {
  return api(projectApi(id, 'rec-delete'), { take });
}
export async function restoreTake(id, trash) {
  return api(projectApi(id, 'rec-restore'), { trash });
}

async function deleteFromBar() {
  const a = ui.after;
  if (!a || a.busy) return;
  a.busy = true; renderCtl();
  clearTimeout(ui.afterT);
  try {
    const r = await deleteTake(a.id, a.take);
    Object.assign(a, { mode: 'deleted', trash: r.trash, busy: false });
    ui.afterT = setTimeout(() => { if (ui.after === a) { ui.after = null; renderCtl(); } }, 10000);
  } catch (e) {
    Object.assign(a, { mode: 'refused', message: e.message, busy: false });
  }
  renderCtl();
}
async function undoDelete() {
  const a = ui.after;
  if (!a?.trash || a.busy) return;
  a.busy = true; renderCtl();
  clearTimeout(ui.afterT);
  try {
    await restoreTake(a.id, a.trash);
    Object.assign(a, { mode: 'restored', busy: false });
  } catch (e) {
    Object.assign(a, { mode: 'refused', message: `Couldn't bring it back: ${e.message} It is in the studio's .trash folder.`, busy: false });
  }
  ui.afterT = setTimeout(() => { if (ui.after === a) { ui.after = null; renderCtl(); } }, 4000);
  renderCtl();
}

// ---------- the control bar ----------
const ICON = {
  pause: '<svg viewBox="0 0 16 16" aria-hidden="true"><rect x="4" y="3" width="3" height="10" rx="1"/><rect x="9" y="3" width="3" height="10" rx="1"/></svg>',
  resume: '<svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="5"/></svg>',
  restart: '<svg viewBox="0 0 16 16" aria-hidden="true" class="line"><path d="M3.5 8a4.5 4.5 0 1 0 1.4-3.3"/><path d="M3 2.5v3h3"/></svg>',
  stop: '<svg viewBox="0 0 16 16" aria-hidden="true"><rect x="3.5" y="3.5" width="9" height="9" rx="1.5"/></svg>',
};
let ctl = null, dockSlot = null, ctlTick = 0;
const mmss = (ms) => { const s = Math.max(0, Math.floor(ms / 1000)); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; };

function buildCtl() {
  ctl = h(`<div class="rc" role="region" aria-label="Recording controls">
    <span class="rc-state"><i class="rc-dot" aria-hidden="true"></i><span class="rc-label"></span><span class="rc-time" aria-live="off"></span></span>
    <span class="rc-btns">
      <button type="button" class="rc-btn" data-a="pause"></button>
      <button type="button" class="rc-btn" data-a="restart" aria-label="Restart" title="Restart: discard this take and record it again (${RESTART_KEY})">${ICON.restart}<span>Restart</span></button>
      <button type="button" class="rc-btn stop" data-a="stop" aria-label="Stop" title="Stop and save the take (${HOTKEY})">${ICON.stop}<span>Stop</span></button>
    </span>
    <span class="rc-confirm" role="alert">
      <span class="rc-q">Restart? This take will be discarded.</span>
      <button type="button" class="rc-btn danger" data-a="yes" title="Discard this take and start again (${RESTART_KEY} again)">Discard and restart</button>
      <button type="button" class="rc-btn" data-a="no" title="Keep recording (Esc)">Keep recording</button>
    </span>
    <span class="rc-after" role="status">
      <span class="rc-msg"></span>
      <button type="button" class="rc-btn" data-a="delete" title="Move this take to the studio's trash and out of the project. Undo brings it back.">Delete take</button>
      <button type="button" class="rc-btn" data-a="undo">Undo</button>
      <button type="button" class="rc-btn ghost" data-a="close" aria-label="Close">✕</button>
    </span>
  </div>`);
  ctl.addEventListener('click', (e) => {
    const a = e.target.closest('[data-a]')?.dataset.a;
    if (a === 'pause') togglePause();
    else if (a === 'restart') askRestart();
    else if (a === 'yes') restart();
    else if (a === 'no') cancelRestart();
    else if (a === 'stop') { cancelRestart(); stop(); }
    else if (a === 'delete') deleteFromBar();
    else if (a === 'undo') undoDelete();
    else if (a === 'close') { ui.after = null; renderCtl(); }
  });
}

// Floating over the app, or docked in the script's bar while the script scrolls.
function placeCtl() {
  if (!ctl) return;
  const docked = Boolean(dockSlot?.isConnected) && !ui.after;
  const home = docked ? dockSlot : document.body;
  if (ctl.parentNode !== home) home.append(ctl);
  ctl.classList.toggle('docked', docked);
}
export const dockControls = (slot) => { dockSlot = slot; renderCtl(); };
export const undockControls = (slot) => { if (dockSlot === slot) dockSlot = null; renderCtl(); };

function renderCtl() {
  if (S.phase !== 'recording' && ui.confirm) { ui.confirm = false; clearTimeout(ui.confirmT); } // stopped meanwhile
  const live = ['starting', 'recording', 'stopping', 'saving'].includes(S.phase);
  if (!live && !ui.after) { clearInterval(ctlTick); ctlTick = 0; ctl?.remove(); return; }
  if (!ctl) buildCtl();
  placeCtl();
  const mode = live ? (ui.confirm && S.phase === 'recording' ? 'confirm' : S.phase === 'recording' && S.paused ? 'paused' : S.phase) : 'after';
  ctl.dataset.mode = mode;
  const q = (sel) => ctl.querySelector(sel);
  const label = { starting: S.restarting ? 'Starting again…' : 'Starting…', recording: 'Recording', paused: 'Paused', confirm: 'Recording',
    stopping: 'Finishing…', saving: `Saving take… ${Math.round((S.progress || 0) * 100)}%`, after: '' }[mode];
  q('.rc-label').textContent = label;
  const pb = q('[data-a=pause]');
  pb.innerHTML = `${S.paused ? ICON.resume : ICON.pause}<span>${S.paused ? 'Resume' : 'Pause'}</span>`;
  pb.title = `${S.paused ? 'Resume recording' : 'Pause recording'} (${PAUSE_KEY})`;
  pb.setAttribute('aria-pressed', String(Boolean(S.paused)));
  pb.setAttribute('aria-label', S.paused ? 'Resume' : 'Pause');
  for (const b of ctl.querySelectorAll('.rc-btns .rc-btn')) b.disabled = S.phase !== 'recording';
  const a = ui.after;
  if (mode === 'after' && a) {
    q('.rc-msg').textContent = { saved: 'Take saved into the project.', deleted: 'Take moved to the studio’s trash.', restored: 'The take is back.', refused: a.message || '' }[a.mode];
    q('[data-a=delete]').hidden = a.mode !== 'saved';
    q('[data-a=undo]').hidden = a.mode !== 'deleted';
    for (const b of ctl.querySelectorAll('.rc-after .rc-btn')) b.disabled = Boolean(a.busy);
  }
  const time = () => { const t = q('.rc-time'); if (t) t.textContent = ['recording', 'paused', 'confirm'].includes(mode) ? mmss(Date.now() - S.startedAt) : ''; };
  time();
  clearInterval(ctlTick);
  ctlTick = ['recording', 'paused', 'confirm'].includes(mode) ? setInterval(time, 250) : 0;
}
onSession(() => renderCtl());

// ---------- the record panel ----------
let panelOpen = null; // { start() } while the panel is up, for the hotkey
let opening = false; // the panel is asking Video Octopus for the project (a second press does nothing meanwhile)
export const panelIsOpen = () => Boolean(panelOpen);
export const startFromPanel = () => panelOpen?.start();
export const closePanel = () => panelOpen?.close();

// choices: what the panel starts with (P.recorder, server/browser-recorder.mjs recorderChoices): { screen, camera, mic,
// target, countdown } and preset: the screen and camera come from the style's setup (web/rec-preset.js: a faceless style
// starts with the camera off, a camera-only one with no screen), or from the last take recorded with this style; the
// line over the sources says which. A change here is remembered for the style when the take starts.
// P: the project; opts.target/label: a block, or 'replace' / 'layer' (the editor's Media section).
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
    // The Media section asks for one: Record again ('replace') or Add as a layer → Record ('layer').
    target: /^block:/.test(opts.target || '') ? opts.target : opts.target === 'replace' ? 'replace'
      : hasTake && (opts.target === 'layer' || (!opts.target && ch.target === 'layer')) ? 'layer' : 'replace',
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
          ${presetLine(ch.preset)}
          <div class="rp-f"><span id="scrL">Screen</span><div class="rp-scr"><div class="seg rp-onoff" id="scrOnOff" role="radiogroup" aria-labelledby="scrL">
            <button type="button" role="radio" id="scrOn">On</button><button type="button" role="radio" id="scrNone">Off</button></div>
            <button type="button" class="btn small" id="scrPick">Choose window…</button><span class="rp-scr-name" id="scrName"></span></div></div>
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
    // Screen: On / Off. On: what's picked, or that the browser asks when you start; Choose window… only then.
    const on = sel.display !== 'none';
    for (const [b, yes] of [[$('#scrOn', page), on], [$('#scrNone', page), !on]]) { b.classList.toggle('on', yes); b.setAttribute('aria-checked', String(yes)); }
    $('#scrName', page).textContent = !on ? 'Not recorded: camera or mic only.' : d.screen ? `Recording ${label(d.screen) || 'the picked screen'}` : 'The browser asks which screen or window when you press Start.';
    $('#scrPick', page).hidden = !on;
    $('#scrPick', page).textContent = d.screen ? 'Choose another…' : 'Choose window…';
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
  $('#scrOn', page).onclick = () => { sel.display = 'screen'; show(); };
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
    // The script, if there is one, scrolls once the take starts; the recording controls sit in its bar meanwhile.
    prompterForTake(id, { onSession, stop, dock: dockControls, undock: undockControls });
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

// "Set up for Faceless explainer: screen and voice, no camera." over the sources (or what was last used with the style).
export function presetLine(p) {
  if (!p) return '';
  const who = p.style ? `<b>${esc(p.style)}</b>` : 'this video’s setup';
  return `<p class="sub rp-preset" id="rPreset">${p.remembered ? `As you last recorded with ${who}.` : `Set up for ${who}: ${esc(p.words || '')}.`} Change anything and the next take with this style starts the same way.</p>`;
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
function countdown(n, say = 'Recording starts… switch to what you want to record.') {
  return new Promise((done) => {
    const el = h(`<div class="countdown"><div class="num"></div><div class="sub">${esc(say)}</div><button class="btn small">Cancel</button></div>`);
    document.body.append(el);
    let left = n, t = 0;
    const finish = (ok) => { clearTimeout(t); el.remove(); done(ok); };
    $('button', el).onclick = () => finish(false);
    const tick = () => { if (left <= 0) return finish(true); $('.num', el).textContent = left; left -= 1; t = setTimeout(tick, 1000); };
    tick();
  });
}

// For tests (headless Chromium with fake devices): the running take's streams.
window.__studioRec = { session, streams: () => run?.d || dev, stop, pause, resume, restart, askRestart, deleteTake, restoreTake };
