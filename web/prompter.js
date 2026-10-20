// The script prompter. The record panel's Script card keeps the project's script (script.md in its folder); during a
// take it scrolls over Video Octopus and starts when the recording starts, or in its own window (web/prompter.html) for a
// teleprompter screen or a second display. Text reads normally: a teleprompter's glass flips it itself, so Mirror is
// off unless turned on. [Cues] in brackets show dim, so they aren't read out.
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
async function saveScript(id, text) {
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
  onSession((S) => { take = { phase: S.phase, project: S.project, startedAt: S.startedAt }; chan?.postMessage({ t: 'take', ...take }); });
  chan?.addEventListener('message', (e) => {
    const m = e.data || {};
    if (m.t === 'window') m.open ? windows.add(m.project) : windows.delete(m.project);
    if (m.t === 'hello') chan.postMessage({ t: 'take', ...take });
  });
}
const openWindow = (id) => window.open(`/prompter.html?p=${encodeURIComponent(id)}`, `studio-script-${id}`, 'popup,width=1100,height=720');

// ---------- the prompter itself (the in-Video Octopus view and the window use the same one) ----------
export function mountPrompter(root, text, { onEscape, hint = '' } = {}) {
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
  const draw = () => { el.style.transform = `translateY(${root.clientHeight * READ_LINE - y}px)`; };
  const hud = (msg) => {
    hudEl.textContent = msg || `speed ${o.speed} · size ${o.size}${o.mirror ? ' · mirrored' : ''}${playing ? '' : ' · paused'}`;
    hudEl.style.opacity = 1; clearTimeout(hudT); hudT = setTimeout(() => { hudEl.style.opacity = 0; }, 1600);
  };
  const setText = (t) => {
    el.textContent = '';
    String(t || '').trim().split(/(\[[^\]\n]+\])/).forEach((part, i) => {
      if (i % 2) el.append(Object.assign(document.createElement('span'), { className: 'pp-cue', textContent: part }));
      else el.append(part);
    });
  };
  const keep = (k) => store.set(k, o[k]);
  const play = (on) => { playing = on; last = performance.now(); hud(); };
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
    const step = (name, d, lo, hi) => { o[name] = clamp(o[name] + d, lo, hi); keep(name); };
    if (k === ' ') play(!playing);
    else if (k === 'ArrowUp') { step('speed', 5, 10, 200); hud(); }
    else if (k === 'ArrowDown') { step('speed', -5, 10, 200); hud(); }
    else if (k === '+' || k === '=') { step('size', 4, 24, 160); style(); draw(); hud(); }
    else if (k === '-' || k === '_') { step('size', -4, 24, 160); style(); draw(); hud(); }
    else if (k === 'ArrowLeft') { y = Math.max(0, y - root.clientHeight * 0.15); draw(); }
    else if (k === 'ArrowRight') { y += root.clientHeight * 0.15; draw(); }
    else if (k === 'r' || k === 'R') { y = 0; draw(); playing = false; hud('back to the start · paused'); }
    else if (k === 'm' || k === 'M') { o.mirror = !o.mirror; keep('mirror'); style(); hud(); }
    else if (k === 'u' || k === 'U') { o.flip = !o.flip; keep('flip'); style(); hud(o.flip ? 'upside down' : 'right way up'); }
    else if (k === 'f' || k === 'F') { document.fullscreenElement ? document.exitFullscreen() : root.requestFullscreen?.().catch(() => {}); }
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
    play, setText, hud,
    get playing() { return playing; },
    restart() { y = 0; draw(); },
    destroy() { alive = false; cancelAnimationFrame(raf); clearTimeout(hudT); removeEventListener('keydown', onKey, true); removeEventListener('resize', onResize); root.removeEventListener('wheel', onWheel); },
  };
}

// ---------- in Video Octopus, during a take ----------
let shown = null;
// Called as a take starts (the record panel has just closed). Nothing to show: no script, Scroll in Video Octopus off, or
// its own window is open for this project.
export function prompterForTake(id, { onSession, stop }) {
  const text = scripts.get(id);
  if (!text?.trim() || !store.get('inStudio', true) || windows.has(id)) return;
  shown?.close();
  const ov = h(`<div class="pp-over" role="region" aria-label="Script">
    <div class="pp-host"></div>
    <div class="pp-bar"><span class="pp-rec"><i aria-hidden="true"></i><span class="pp-clock">Starts with the recording</span></span>
      <span class="pp-keys"><kbd>Space</kbd> pause · <kbd>↑</kbd><kbd>↓</kbd> speed · <kbd>+</kbd><kbd>−</kbd> size · <kbd>←</kbd><kbd>→</kbd> nudge · <kbd>R</kbd> start · <kbd>M</kbd> mirror · <kbd>F</kbd> full screen</span>
      <span class="gap"></span><button class="btn small ghost" data-a="hide">Hide script</button><button class="btn small danger" data-a="stop"><span class="sq" aria-hidden="true"></span>Stop recording</button></div></div>`);
  document.body.append(ov);
  const p = mountPrompter($('.pp-host', ov), text, { onEscape: () => close() });
  let tick = 0, started = false;
  const clock = () => { const s = Math.floor((Date.now() - take.startedAt) / 1000); $('.pp-clock', ov).textContent = `Recording ${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; };
  const off = onSession((S) => {
    if (S.project !== id) return;
    if (S.phase === 'recording' && !started) { started = true; ov.classList.add('live'); p.play(true); clock(); tick = setInterval(clock, 500); }
    if (['stopping', 'saving', 'idle'].includes(S.phase)) close();
  });
  function close() { if (!ov.isConnected) return; off(); clearInterval(tick); p.destroy(); ov.remove(); if (shown?.ov === ov) shown = null; }
  ov.querySelector('[data-a=hide]').onclick = () => { close(); toast('Script hidden for this take. The recording goes on.'); };
  ov.querySelector('[data-a=stop]').onclick = () => stop();
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
    <div class="pp-bar"><span class="pp-rec">Practice · not recording</span><span class="pp-keys"><kbd>Space</kbd> start or pause · <kbd>↑</kbd><kbd>↓</kbd> speed · <kbd>+</kbd><kbd>−</kbd> size · <kbd>←</kbd><kbd>→</kbd> nudge · <kbd>R</kbd> start · <kbd>M</kbd> mirror · <kbd>F</kbd> full screen</span>
      <span class="gap"></span><button class="btn small" data-a="done">Done</button></div></div>`);
  document.body.append(ov);
  const close = () => { p.destroy(); ov.remove(); };
  const p = mountPrompter($('.pp-host', ov), scripts.get(id) || '', { onEscape: close, hint: 'Space starts it · the speed and size you set here are kept' });
  $('[data-a=done]', ov).onclick = close;
}
