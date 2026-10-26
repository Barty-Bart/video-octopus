// The script prompter. The record panel's Script card keeps the project's script (script.md in its folder); during a
// take it scrolls over Video Octopus and starts when the recording starts, or in its own window (web/prompter.html) for a
// teleprompter screen or a second display. Text reads normally: a teleprompter's glass flips it itself, so Mirror is
// off unless turned on. [Cues] in brackets show dim, so they aren't read out.
//
// Every key has a button too (prompterControls, styled in recorder.css): start, back, play/pause, forward, speed −/+,
// size −/+, mirror and full screen, in the practice run, during a take and in the script's own window. During a take
// the script pauses and resumes with the recording, and goes back to the top when the take restarts.
import { $, esc, h, api, toast } from './ui.js';

const KEY = 'studio.prompter.';
const store = {
  get(k, d) { try { const v = localStorage.getItem(KEY + k); return v === null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem(KEY + k, JSON.stringify(v)); } catch {} },
};
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const READ_LINE = 0.33; // the reading line, a third down (close to the lens)
const WPM = 150; // speaking pace, for "about 5 min"

export const words = (t) => (String(t || '').replace(/\[[^\]\n]*\]/g, ' ').match(/[\p{L}\p{N}][\p{L}\p{N}'’-]*/gu) || []).length;
const spoken = (n) => { const m = n / WPM; return m < 1 ? 'under a minute' : `about ${Math.round(m)} min`; };

// ---------- the project's script ----------
const scripts = new Map(); // project id → text, as last loaded or saved
export async function loadScript(id) {
  let text = '';
  try { text = (await api(`/api/projects/${encodeURIComponent(id)}/script`)).text || ''; } catch {}
  scripts.set(id, text);
  return text;
}
export async function saveScript(id, text) {
  await api(`/api/projects/${encodeURIComponent(id)}/script`, { text });
  scripts.set(id, text.trim() ? text : '');
  chan?.postMessage({ t: 'script', project: id, text });
}

// ---------- Video Octopus ↔ the script's own window ----------
const chan = 'BroadcastChannel' in window ? new BroadcastChannel('studio-prompter') : null;
const windows = new Set(); // projects whose script has its own window open
let take = { phase: 'idle', project: null, startedAt: 0 };
// Video Octopus's side: the recorder's session goes out to any script window, and a window says when it opens or closes.
export function syncWithRecorder(onSession) {
  onSession((S) => { take = { phase: S.phase, project: S.project, startedAt: S.startedAt, paused: Boolean(S.paused) }; chan?.postMessage({ t: 'take', ...take }); });
  chan?.addEventListener('message', (e) => {
    const m = e.data || {};
    if (m.t === 'window') m.open ? windows.add(m.project) : windows.delete(m.project);
    if (m.t === 'hello') chan.postMessage({ t: 'take', ...take });
  });
}
const openWindow = (id) => window.open(`/prompter.html?p=${encodeURIComponent(id)}`, `studio-script-${id}`, 'popup,width=1100,height=720');

// ---------- the prompter itself (the in-Video Octopus view and the window use the same one) ----------
// fullscreen: what F (and the Full screen button) makes full screen; the prompter itself unless its overlay is given.
// paragraphs: the current paragraph (the one on the reading line) bright and the rest dimmed (Simple mode's full-window
// teleprompter); onSpace: what Space does instead of playing or pausing the script (there, it pauses the recording).
export function mountPrompter(root, text, { onEscape, hint = '', fullscreen: fullTarget = root, paragraphs = false, onSpace = null } = {}) {
  root.classList.add('pp');
  root.innerHTML = '<div class="pp-stage"><div class="pp-text"></div><div class="pp-line"></div></div><div class="pp-hud" aria-live="polite"></div>';
  const stage = $('.pp-stage', root), el = $('.pp-text', root), hudEl = $('.pp-hud', root);
  const o = { speed: store.get('speed', 60), size: store.get('size', 64), mirror: store.get('mirror', false), flip: store.get('flip', false) };
  let y = 0, playing = false, last = performance.now(), raf = 0, hudT = 0, alive = true;
  const style = () => {
    el.style.fontSize = `${o.size}px`;
    stage.classList.toggle('flipH', o.mirror); stage.classList.toggle('flipV', o.flip);
    $('.pp-line', root).style.top = `${root.clientHeight * READ_LINE}px`;
  };
  let pars = [], parOn = -1;
  const draw = () => {
    el.style.transform = `translateY(${root.clientHeight * READ_LINE - y}px)`;
    if (!pars.length) return;
    // The paragraph under the reading line (its top above it, the next one's below), lit.
    let k = 0;
    for (let i = 0; i < pars.length; i++) if (pars[i].offsetTop <= y + 4) k = i;
    if (k !== parOn) { pars[parOn]?.classList.remove('on'); pars[k]?.classList.add('on'); parOn = k; }
  };
  const hud = (msg) => {
    hudEl.textContent = msg || `speed ${o.speed} · size ${o.size}${o.mirror ? ' · mirrored' : ''}${playing ? '' : ' · paused'}`;
    hudEl.style.opacity = 1; clearTimeout(hudT); hudT = setTimeout(() => { hudEl.style.opacity = 0; }, 1600);
  };
  const setText = (t) => {
    el.textContent = '';
    pars = []; parOn = -1;
    if (paragraphs) {
      for (const para of String(t || '').trim().split(/\n\s*\n|\n/).map((x) => x.trim()).filter(Boolean)) {
        const p = Object.assign(document.createElement('p'), { className: 'pp-par' });
        para.split(/(\[[^\]\n]+\])/).forEach((part, i) => p.append(i % 2 ? Object.assign(document.createElement('span'), { className: 'pp-cue', textContent: part }) : part));
        el.append(p); pars.push(p);
      }
      return;
    }
    String(t || '').trim().split(/(\[[^\]\n]+\])/).forEach((part, i) => {
      if (i % 2) el.append(Object.assign(document.createElement('span'), { className: 'pp-cue', textContent: part }));
      else el.append(part);
    });
  };
  const keep = (k) => store.set(k, o[k]);
  const watchers = new Set(); // the buttons, which show the speed, the size and playing or paused
  const changed = () => { for (const fn of watchers) fn(); };
  const play = (on) => { playing = on; last = performance.now(); hud(); changed(); };
  const step = (name, d, lo, hi) => { o[name] = clamp(o[name] + d, lo, hi); keep(name); };
  // What the keys and the buttons do.
  const act = {
    toggle: () => play(!playing),
    faster: () => { step('speed', 5, 10, 200); hud(); changed(); },
    slower: () => { step('speed', -5, 10, 200); hud(); changed(); },
    bigger: () => { step('size', 4, 24, 160); style(); draw(); hud(); changed(); },
    smaller: () => { step('size', -4, 24, 160); style(); draw(); hud(); changed(); },
    back: () => { y = Math.max(0, y - root.clientHeight * 0.15); draw(); },
    forward: () => { y += root.clientHeight * 0.15; draw(); },
    toStart: () => { y = 0; draw(); playing = false; hud('back to the start · paused'); changed(); },
    mirror: () => { o.mirror = !o.mirror; keep('mirror'); style(); hud(); changed(); },
    flip: () => { o.flip = !o.flip; keep('flip'); style(); hud(o.flip ? 'upside down' : 'right way up'); changed(); },
    fullscreen: (target = root) => { document.fullscreenElement ? document.exitFullscreen() : target.requestFullscreen?.().catch(() => {}); },
  };
  const loop = (t) => {
    if (!alive) return;
    if (playing) {
      y += o.speed * ((t - last) / 1000) * (o.size / 64); // the speed scales with the text size
      if (y > el.scrollHeight) { y = el.scrollHeight; playing = false; hud('end of the script'); }
      draw();
    }
    last = t; raf = requestAnimationFrame(loop);
  };
  // Window-level and first, so the editor's own keys (Space plays the video) don't fire under the script.
  const onKey = (e) => {
    if (e.metaKey || e.ctrlKey || e.altKey || /TEXTAREA|INPUT|SELECT/.test(document.activeElement?.tagName || '')) return;
    const k = e.key;
    if (k === ' ') (onSpace || act.toggle)();
    else if (k === 'ArrowUp') act.faster();
    else if (k === 'ArrowDown') act.slower();
    else if (k === '+' || k === '=') act.bigger();
    else if (k === '-' || k === '_') act.smaller();
    else if (k === 'ArrowLeft') act.back();
    else if (k === 'ArrowRight') act.forward();
    else if (k === 'r' || k === 'R') act.toStart();
    else if (k === 'm' || k === 'M') act.mirror();
    else if (k === 'u' || k === 'U') act.flip();
    else if (k === 'f' || k === 'F') act.fullscreen(fullTarget);
    else if (k === 'Escape' && onEscape) onEscape();
    else return;
    e.preventDefault(); e.stopPropagation();
  };
  const onWheel = (e) => { y = Math.max(0, y + e.deltaY); draw(); };
  const onResize = () => { style(); draw(); };
  addEventListener('keydown', onKey, true);
  root.addEventListener('wheel', onWheel, { passive: true });
  addEventListener('resize', onResize);
  setText(text); style(); draw(); raf = requestAnimationFrame(loop);
  if (hint) hud(hint);
  return {
    play, setText, hud, act,
    get playing() { return playing; },
    get speed() { return o.speed; },
    get size() { return o.size; },
    get mirrored() { return o.mirror; },
    fullTarget,
    onChange(fn) { watchers.add(fn); return () => watchers.delete(fn); },
    restart() { y = 0; draw(); },
    destroy() { alive = false; watchers.clear(); cancelAnimationFrame(raf); clearTimeout(hudT); removeEventListener('keydown', onKey, true); removeEventListener('resize', onResize); root.removeEventListener('wheel', onWheel); },
  };
}

// ---------- the prompter's buttons (every key has one; the key is in the tooltip) ----------
const SVG = (d, cls = '') => `<svg viewBox="0 0 16 16" aria-hidden="true"${cls ? ` class="${cls}"` : ''}>${d}</svg>`;
const PI = {
  start: SVG('<path d="M4 3v10"/><path d="M12.5 3.5 6.5 8l6 4.5"/>', 'line'),
  back: SVG('<path d="M8 3.5 3 8l5 4.5M13.5 3.5 8.5 8l5 4.5"/>', 'line'),
  forward: SVG('<path d="M8 3.5 13 8l-5 4.5M2.5 3.5 7.5 8l-5 4.5"/>', 'line'),
  play: SVG('<path d="M5 3.2v9.6L12.8 8z"/>'),
  pause: SVG('<rect x="4" y="3" width="3" height="10" rx="1"/><rect x="9" y="3" width="3" height="10" rx="1"/>'),
  mirror: SVG('<path d="M8 2v12"/><path d="M5.5 5 2.5 8l3 3M10.5 5l3 3-3 3"/>', 'line'),
  full: SVG('<path d="M2.5 6V2.5H6M10 2.5h3.5V6M13.5 10v3.5H10M6 13.5H2.5V10"/>', 'line'),
};
export function prompterControls(p) {
  const el = h(`<div class="ppc" role="toolbar" aria-label="Script controls">
    <span class="ppc-g">
      <button type="button" class="ppc-b" data-p="toStart" title="Back to the start (R)" aria-label="Back to the start">${PI.start}</button>
      <button type="button" class="ppc-b" data-p="back" title="Back a little (←)" aria-label="Back a little">${PI.back}</button>
      <button type="button" class="ppc-b ppc-play" data-p="toggle"></button>
      <button type="button" class="ppc-b" data-p="forward" title="Forward a little (→)" aria-label="Forward a little">${PI.forward}</button>
    </span>
    <span class="ppc-g" role="group" aria-label="Speed">
      <span class="ppc-l">Speed</span>
      <button type="button" class="ppc-b" data-p="slower" title="Slower (↓)" aria-label="Slower">−</button>
      <output class="ppc-v" data-v="speed"></output>
      <button type="button" class="ppc-b" data-p="faster" title="Faster (↑)" aria-label="Faster">+</button>
    </span>
    <span class="ppc-g" role="group" aria-label="Text size">
      <span class="ppc-l">Size</span>
      <button type="button" class="ppc-b" data-p="smaller" title="Smaller text (−)" aria-label="Smaller text">−</button>
      <output class="ppc-v" data-v="size"></output>
      <button type="button" class="ppc-b" data-p="bigger" title="Bigger text (+)" aria-label="Bigger text">+</button>
    </span>
    <span class="ppc-g">
      <button type="button" class="ppc-b" data-p="mirror" title="Mirror the text, for a teleprompter's glass (M)" aria-label="Mirror">${PI.mirror}</button>
      <button type="button" class="ppc-b" data-p="fullscreen" title="Full screen (F)" aria-label="Full screen">${PI.full}</button>
    </span>
  </div>`);
  const sync = () => {
    const b = el.querySelector('.ppc-play');
    // "script": in the take's bar it sits next to the recording's own Pause.
    b.innerHTML = `${p.playing ? PI.pause : PI.play}<span>${p.playing ? 'Pause script' : 'Play script'}</span>`;
    b.title = `${p.playing ? 'Pause the script' : 'Play the script'} (Space)`;
    b.setAttribute('aria-label', p.playing ? 'Pause the script' : 'Play the script');
    el.querySelector('[data-v=speed]').textContent = p.speed;
    el.querySelector('[data-v=size]').textContent = p.size;
    el.querySelector('[data-p=mirror]').setAttribute('aria-pressed', String(p.mirrored));
  };
  el.addEventListener('click', (e) => {
    const a = e.target.closest('[data-p]')?.dataset.p;
    if (!a) return;
    if (a === 'fullscreen') p.act.fullscreen(p.fullTarget);
    else p.act[a]();
  });
  const off = p.onChange(sync);
  sync();
  el.destroy = off;
  return el;
}

// ---------- in Video Octopus, during a take ----------
let shown = null;
// Called as a take starts (the record panel has just closed). Nothing to show: no script, Scroll in Video Octopus off, or
// its own window is open for this project.
// dock/undock: the recorder's own controls (time, Pause, Restart, Stop) go into this bar while it's up.
export function prompterForTake(id, { onSession, stop, dock, undock }) {
  const text = scripts.get(id);
  if (!text?.trim() || !store.get('inStudio', true) || windows.has(id)) return;
  shown?.close();
  const ov = h(`<div class="pp-over" role="region" aria-label="Script">
    <div class="pp-host"></div>
    <div class="pp-bar"><span class="pp-recslot"><span class="pp-rec"><i aria-hidden="true"></i><span class="pp-clock">Starts with the recording</span></span>
      <button class="btn small danger" data-a="stop"><span class="sq" aria-hidden="true"></span>Stop recording</button></span>
      <span class="pp-ctlslot"></span>
      <span class="gap"></span><button class="btn small ghost" data-a="hide">Hide script</button></div></div>`);
  document.body.append(ov);
  const p = mountPrompter($('.pp-host', ov), text, { onEscape: () => close(), fullscreen: ov });
  const ctl = prompterControls(p);
  $('.pp-ctlslot', ov).replaceWith(ctl);
  const slot = $('.pp-recslot', ov);
  ov.querySelector('[data-a=stop]').onclick = () => stop();
  // The recorder's bar takes the slot (its time, Pause, Restart and Stop); without it the plain clock and Stop stay.
  if (dock) { slot.replaceChildren(); dock(slot); }
  let tick = 0, started = false, wasPlaying = false, paused = false;
  const clock = () => { const c = $('.pp-clock', ov); if (c) { const s = Math.floor((Date.now() - take.startedAt) / 1000); c.textContent = `Recording ${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; } };
  const off = onSession((S) => {
    if (S.project !== id) return;
    if (S.phase === 'recording' && !started) { started = true; paused = false; ov.classList.add('live'); p.play(true); clock(); tick = setInterval(clock, 500); }
    // The take restarts: back to the top, waiting for the new take.
    if (S.phase === 'starting' && started) { started = false; clearInterval(tick); ov.classList.remove('live'); p.play(false); p.restart(); p.hud('the take restarts · the script goes back to the top'); }
    // Pause and resume with the recording (a script paused by hand stays paused).
    if (S.phase === 'recording' && started && Boolean(S.paused) !== paused) {
      paused = Boolean(S.paused);
      if (paused) { wasPlaying = p.playing; p.play(false); p.hud('paused with the recording'); }
      else if (wasPlaying) p.play(true);
    }
    if (['stopping', 'saving', 'idle'].includes(S.phase)) close();
  });
  function close() { if (!ov.isConnected) return; off(); clearInterval(tick); undock?.(slot); ctl.destroy(); p.destroy(); ov.remove(); if (shown?.ov === ov) shown = null; }
  ov.querySelector('[data-a=hide]').onclick = () => { close(); toast('Script hidden for this take. The recording goes on.'); };
  shown = { ov, close };
}

// ---------- the record panel's Script card ----------
export function scriptCard(card, id) {
  const draw = () => {
    const text = scripts.get(id) || '';
    const n = words(text), first = text.replace(/\[[^\]\n]*\]/g, '').split('\n').map((l) => l.trim()).find(Boolean) || '';
    card.innerHTML = text.trim()
      ? `<h3>Script</h3>
        <div class="rp-sc-sum"><span class="rp-sc-first">${esc(first.slice(0, 140))}</span><span class="sub">${n} words · ${spoken(n)} at speaking pace</span></div>
        <label class="rp-check"><input type="checkbox" id="scIn"${store.get('inStudio', true) ? ' checked' : ''}> Scroll it in Video Octopus while I record</label>
        <div class="rp-sc-btns"><button type="button" class="btn small" id="scEdit">Edit</button><button type="button" class="btn small ghost" id="scTry">Try it</button><button type="button" class="btn small ghost" id="scWin" title="For a teleprompter screen or a second display">Own window</button></div>`
      : `<h3>Script</h3><p class="sub rp-sc-none">Reading from a script? Put it here and it scrolls while you record, starting with the take.</p>
        <button type="button" class="btn small" id="scEdit">Put a script</button>`;
    $('#scEdit', card).onclick = () => editScript(id, draw);
    const inS = $('#scIn', card); if (inS) inS.onchange = () => store.set('inStudio', inS.checked);
    const tryB = $('#scTry', card); if (tryB) tryB.onclick = () => tryScript(id);
    const win = $('#scWin', card); if (win) win.onclick = () => { if (!openWindow(id)) toast('The browser blocked the window: allow pop-ups for Video Octopus.'); };
  };
  card.innerHTML = '<h3>Script</h3><p class="sub">Loading…</p>';
  loadScript(id).then(draw, draw);
}

// Paste it, open a .txt or .md file, or drop one on the box.
function editScript(id, done) {
  const m = h(`<div class="modal pp-modal"><div class="dialog pp-edit" role="dialog" aria-modal="true" aria-labelledby="scTitle">
    <h3 id="scTitle">Script</h3>
    <p class="sub">Paste it, or drop a .txt or .md file on the box. It scrolls while you record. Cues in brackets, like [calm] or [long pause], show dim so you don't read them out.</p>
    <textarea class="field pp-ta" id="scText" spellcheck="true" placeholder="Paste your script here, or drop a .txt or .md file…"></textarea>
    <div class="actions"><span class="sub" id="scCount"></span><span class="gap"></span>
      <button type="button" class="btn ghost small" id="scOpen">Open file…</button><input type="file" id="scFile" accept=".txt,.md,.markdown,.text,text/plain,text/markdown" hidden>
      ${scripts.get(id)?.trim() ? '<button type="button" class="btn ghost small" id="scDel">Remove</button>' : ''}
      <button type="button" class="btn ghost" id="scCancel">Cancel</button><button type="button" class="btn primary" id="scSave">Save script</button></div></div></div>`);
  document.body.append(m);
  const ta = $('#scText', m);
  ta.value = scripts.get(id) || '';
  const count = () => { const n = words(ta.value); $('#scCount', m).textContent = n ? `${n} words · ${spoken(n)}` : ''; };
  const read = async (f) => {
    if (!f) return;
    if (f.size > 400000 || !/\.(txt|md|markdown|text)$/i.test(f.name) && !/^text\//.test(f.type)) return toast('Use a .txt or .md file.');
    ta.value = (await f.text()).replace(/\r\n?/g, '\n'); count(); ta.focus();
  };
  const close = () => { m.remove(); document.removeEventListener('keydown', onKey, true); };
  // First, so Escape closes this box and not the record panel under it.
  const onKey = (e) => { if (e.key === 'Escape') { e.stopPropagation(); close(); } else if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.stopPropagation(); save(); } };
  const save = async () => {
    const b = $('#scSave', m); b.disabled = true;
    try { await saveScript(id, ta.value); close(); done(); } catch (e) { toast(`Couldn't save the script: ${e.message}`); b.disabled = false; }
  };
  document.addEventListener('keydown', onKey, true);
  ta.addEventListener('input', count);
  ta.addEventListener('dragover', (e) => { e.preventDefault(); ta.classList.add('drop'); });
  ta.addEventListener('dragleave', () => ta.classList.remove('drop'));
  ta.addEventListener('drop', (e) => { e.preventDefault(); ta.classList.remove('drop'); read(e.dataTransfer.files[0]); });
  $('#scOpen', m).onclick = () => $('#scFile', m).click();
  $('#scFile', m).onchange = (e) => read(e.target.files[0]);
  $('#scCancel', m).onclick = close;
  $('#scSave', m).onclick = save;
  const del = $('#scDel', m); if (del) del.onclick = async () => { ta.value = ''; await save(); };
  m.addEventListener('mousedown', (e) => { if (e.target === m) close(); });
  count(); ta.focus();
}

// A practice run, with no recording: Space starts it, Escape ends it.
function tryScript(id) {
  const ov = h(`<div class="pp-over try" role="dialog" aria-modal="true" aria-label="Try the script"><div class="pp-host"></div>
    <div class="pp-bar"><span class="pp-rec">Practice · not recording</span><span class="pp-ctlslot"></span>
      <span class="gap"></span><button class="btn small" data-a="done">Done</button></div></div>`);
  document.body.append(ov);
  const close = () => { ctl.destroy(); p.destroy(); ov.remove(); };
  const p = mountPrompter($('.pp-host', ov), scripts.get(id) || '', { onEscape: close, hint: 'Press Play or Space to start · the speed and size you set here are kept', fullscreen: ov });
  const ctl = prompterControls(p);
  $('.pp-ctlslot', ov).replaceWith(ctl);
  $('[data-a=done]', ov).onclick = close;
}
