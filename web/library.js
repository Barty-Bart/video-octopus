// The studio library (Home → Library): styles, sounds, backgrounds, components, B-roll and stills, with
// previews; sounds waiting for approval; "New style from samples"; the Library's own Claude in a side
// panel. Also the pieces projects use: the style picker, "Save to library" on renders, and audio previews.
import { $, esc, h, api, toast, ago, tilde, fileManager } from './ui.js';

export const libUrl = (rel) => `/api/library/file?f=${encodeURIComponent(rel)}`;
const freeUrl = (rel) => `/api/library/free-file?f=${encodeURIComponent(rel)}`;
const isShort = (t) => ['short', 'reel'].includes(t);
const mb = (b) => (b > 1e9 ? `${(b / 1e9).toFixed(1)} GB` : b > 1e6 ? `${(b / 1e6).toFixed(1)} MB` : `${Math.max(1, Math.round((b || 0) / 1e3))} KB`);
export const ICON = {
  play: '<svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true"><path d="M3 1.8l7 4.2-7 4.2z" class="f"/></svg>',
  stop: '<svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true"><rect x="2.5" y="2.5" width="7" height="7" rx="1" class="f"/></svg>',
  x: '<svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true"><path d="M3 3l6 6M9 3l-6 6"/></svg>',
  library: '<svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true"><rect x="2" y="2.5" width="3" height="11" rx="0.8"/><rect x="6.5" y="2.5" width="3" height="11" rx="0.8"/><path d="M11.2 3.4l2.6-.7 2 10.2-2.6.7z" transform="translate(-1.2 0)"/></svg>',
  folder: '<svg width="15" height="15" viewBox="0 0 16 16" aria-hidden="true"><path d="M2.5 3.5h4l1.5 1.5h5.5v7.5h-11z"/></svg>',
};

// ---------- one audio player for every preview button ----------
let player = null, playingBtn = null;
export function playButton(url, title = 'Play') {
  const b = h(`<button class="snd-play" aria-label="${esc(title)}" title="${esc(title)}">${ICON.play}</button>`);
  b.onclick = (e) => { e.stopPropagation(); togglePlay(url, b); };
  return b;
}
export function stopPreview() {
  if (player) player.pause();
  if (playingBtn) { playingBtn.innerHTML = ICON.play; playingBtn.classList.remove('on'); }
  playingBtn = null;
}
export function togglePlay(url, btn, volume = 1) {
  const same = playingBtn === btn && player && !player.paused;
  stopPreview();
  if (same) return;
  player = player || new Audio();
  player.src = url; player.volume = volume; player.currentTime = 0;
  player.play().catch(() => toast('Couldn’t play that sound.'));
  playingBtn = btn;
  if (btn) { btn.innerHTML = ICON.stop; btn.classList.add('on'); }
  player.onended = () => stopPreview();
}

// Small, safe markdown for Claude's replies and style pages.
export function mdLite(src) {
  const inline = (t) => esc(t).replace(/`([^`]+)`/g, '<code>$1</code>').replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>')
    .replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<i>$2</i>').replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
  const out = [];
  let list = null;
  const flush = () => { if (list) { out.push(`<${list.k}>${list.items.map((x) => `<li>${inline(x)}</li>`).join('')}</${list.k}>`); list = null; } };
  for (const raw of String(src || '').replace(/```[\s\S]*?```/g, (m) => m.replace(/\n/g, '\u0001')).split('\n')) {
    const line = raw.replace(/\u0001/g, '\n');
    if (line.startsWith('```')) { flush(); out.push(`<pre>${esc(line.replace(/^```\w*\n?|```$/g, ''))}</pre>`); continue; }
    const m = /^\s*([-*]|\d+[.)])\s+(.*)$/.exec(line);
    if (m) { const k = /\d/.test(m[1]) ? 'ol' : 'ul'; if (!list || list.k !== k) { flush(); list = { k, items: [] }; } list.items.push(m[2]); continue; }
    flush();
    const hd = /^(#{1,4})\s+(.*)$/.exec(line);
    if (hd) out.push(`<h${Math.min(4, hd[1].length + 1)}>${inline(hd[2])}</h${Math.min(4, hd[1].length + 1)}>`);
    else if (line.trim() && !/^\|?[-: |]+\|?$/.test(line)) out.push(`<p>${inline(line)}</p>`);
  }
  flush();
  return out.join('');
}

// ---------- the style picker (a Short's project inspector and its Post tab) ----------
export async function styleSection(host, { id, getP, onChange }) {
  const P = getP();
  if (!isShort(P.type)) { host.replaceChildren(); host.hidden = true; return; }
  host.hidden = false;
  let styles = [];
  try { styles = await api('/api/library/styles'); } catch {}
  const cur = P.kit?.style || '';
  const missing = cur && !styles.some((s) => s.name === cur);
  const sec = h(`<section class="kit-style"><h3>Style</h3>
    <select class="field small" aria-label="This project's style"><option value="">No style</option>${styles.map((s) => `<option value="${esc(s.name)}"${s.name === cur ? ' selected' : ''}>${esc(s.name)}</option>`).join('')}${missing ? `<option value="${esc(cur)}" selected>${esc(cur)} (missing)</option>` : ''}</select>
    <p class="sub">${cur && !missing ? esc(styles.find((s) => s.name === cur)?.note || '') : styles.length ? 'Claude reads the style when it edits and writes for this project.' : 'No styles yet.'} <a href="#/library?new-style">New style from samples</a></p></section>`);
  $('select', sec).onchange = async (e) => {
    try {
      await api(`/api/projects/${encodeURIComponent(id)}/style`, { style: e.target.value });
      toast(e.target.value ? `Style: ${e.target.value}. Claude gets it from your next message.` : 'No style for this project.');
      onChange?.();
    } catch (err) { toast(err.message); }
  };
  host.replaceChildren(sec);
}

// ---------- "Save to library" on renders (the video, or the frame its player is on) ----------
// host gets two buttons; video() returns the render's <video> element.
export function libraryButtons(host, id, file, video) {
  const save = h(`<button class="btn" title="Copy this render into your library as B-roll, a background or a component">Save to library</button>`);
  const frame = h(`<button class="btn" title="Save the frame the player is on as a still or a background">Save this frame</button>`);
  save.onclick = () => saveDialog(id, { file });
  frame.onclick = () => {
    const v = video();
    if (!v?.videoWidth) return toast('Play the video to the frame you want first.');
    const c = document.createElement('canvas');
    c.width = v.videoWidth; c.height = v.videoHeight;
    c.getContext('2d').drawImage(v, 0, 0);
    saveDialog(id, { file, png: c.toDataURL('image/png'), at: v.currentTime });
  };
  host.replaceChildren(save, frame);
}

function saveDialog(id, { file, png, at }) {
  const base = String(file).split('/').pop().replace(/\.[^.]+$/, '');
  const kinds = png ? [['stills', 'Still'], ['backgrounds', 'Background']] : [['broll', 'B-roll'], ['backgrounds', 'Background'], ['components', 'Component']];
  let kind = kinds[0][0];
  const modal = $('#modal');
  const d = h(`<div class="dialog lib-save" role="dialog" aria-modal="true" aria-labelledby="lsT"><h3 id="lsT">Save to library</h3>
    <div class="sub">${png ? `The frame at ${at.toFixed(1)} s of ` : ''}${esc(file)}</div>
    ${png ? `<img class="ls-prev" alt="" src="${png}">` : ''}
    <div class="fl">Goes into</div><div class="seg wide" role="radiogroup">${kinds.map(([k, l]) => `<button role="radio" data-k="${k}">${l}</button>`).join('')}</div>
    <label class="fl" for="lsName">Name</label><input class="field" id="lsName" value="${esc(png ? `${base}_at_${at.toFixed(1).replace('.', '_')}s` : base)}">
    <label class="fl" for="lsNote">What it is (one line, for INDEX.md)</label><input class="field" id="lsNote" placeholder="e.g. paper grid background, 9:16">
    <div class="actions"><button class="btn ghost" data-a="x">Cancel</button><button class="btn primary" data-a="go">Save</button></div></div>`);
  modal.replaceChildren(d); modal.hidden = false;
  const sync = () => d.querySelectorAll('[data-k]').forEach((b) => { b.classList.toggle('on', b.dataset.k === kind); b.setAttribute('aria-checked', String(b.dataset.k === kind)); });
  d.querySelectorAll('[data-k]').forEach((b) => (b.onclick = () => { kind = b.dataset.k; sync(); }));
  sync();
  const close = () => { modal.hidden = true; };
  $('[data-a=x]', d).onclick = close;
  modal.onclick = (e) => { if (e.target === modal) close(); };
  $('[data-a=go]', d).onclick = async () => {
    $('[data-a=go]', d).disabled = true;
    try {
      const r = await api(`/api/projects/${encodeURIComponent(id)}/save-to-library`, { file, png, kind, name: $('#lsName', d).value.trim(), note: $('#lsNote', d).value.trim() });
      close(); toast(`Saved to the library: ${r.file}`);
    } catch (e) { toast(e.message); $('[data-a=go]', d).disabled = false; }
  };
}

// ---------- uploads ----------
async function uploadFile(file, { kind, style, note }, onProgress) {
  return new Promise((done, fail) => {
    const x = new XMLHttpRequest();
    const qs = new URLSearchParams({ kind, name: file.name, ...(style ? { style } : {}), ...(note ? { note } : {}) });
    x.open('POST', `/api/library/upload?${qs}`);
    x.setRequestHeader('X-Studio', '1');
    x.upload.onprogress = (e) => e.lengthComputable && onProgress?.(e.loaded / e.total);
    x.onload = () => { let j = {}; try { j = JSON.parse(x.responseText); } catch {} x.status < 300 ? done(j) : fail(new Error(j.error || `Upload failed (${x.status})`)); };
    x.onerror = () => fail(new Error('Upload failed'));
    x.send(file);
  });
}

// ---------- New style from samples ----------
export function newStyleDialog({ onStarted, files: dropped = [] } = {}) {
  const picked = new Map(); // key -> {kind: 'file'|'path'|'link', label, file?, path?, url?}
  for (const f of dropped) picked.set(`f:${f.name}:${f.size}`, { kind: 'file', label: f.name, file: f });
  const modal = $('#modal');
  const d = h(`<div class="dialog np ns" role="dialog" aria-modal="true" aria-labelledby="nsT">
    <div class="np-head"><div><h3 id="nsT">New style from samples</h3><div class="sub">Pick 3 to 10 short videos in the style you want. Claude studies them and writes the style into your library.</div></div>
      <button class="btn ghost small np-x" data-a="x" aria-label="Close">${ICON.x}</button></div>
    <label class="fl" for="nsName">Name</label><input class="field big" id="nsName" placeholder="e.g. calm-tool-reels" autocomplete="off">
    <div class="fl">Samples <span class="sub" id="nsCount"></span></div>
    <div class="ns-drop" id="nsDrop" tabindex="0"><b>Drop videos here</b><span class="sub">or</span><button class="btn small" data-a="choose">Choose files…</button><input type="file" accept="video/*" multiple hidden id="nsFile"></div>
    <div class="ns-or"><span class="sub">From your studio (read only, nothing is copied)</span>
      <input class="field" id="nsQ" type="search" placeholder="Search your renders: reel, short, final…" autocomplete="off"><div class="ns-vids" id="nsVids"></div></div>
    <label class="fl" for="nsLinks">Or paste links, one per line</label><textarea class="field ns-links" id="nsLinks" rows="3" placeholder="https://www.instagram.com/reel/…"></textarea>
    <div class="ns-picked" id="nsPicked"></div>
    <div class="actions"><span class="sub" id="nsMsg"></span><span class="gap"></span><button class="btn ghost" data-a="x">Cancel</button><button class="btn primary" data-a="go">Make the style</button></div></div>`);
  modal.replaceChildren(d); modal.hidden = false;
  const close = () => { modal.hidden = true; document.removeEventListener('keydown', onEsc); };
  const onEsc = (e) => { if (e.key === 'Escape') close(); };
  document.addEventListener('keydown', onEsc);
  d.querySelectorAll('[data-a=x]').forEach((b) => (b.onclick = close));
  const links = () => $('#nsLinks', d).value.split('\n').map((s) => s.trim()).filter((s) => /^https?:\/\/\S+$/.test(s));
  const count = () => picked.size + links().length;
  const draw = () => {
    const n = count();
    $('#nsCount', d).textContent = `${n} picked${n < 3 ? `, ${3 - n} more to go` : n > 10 ? ', 10 at most' : ''}`;
    $('[data-a=go]', d).disabled = n < 3 || n > 10;
    $('#nsPicked', d).replaceChildren(...[...picked.entries()].map(([k, x]) => {
      const c = h(`<span class="ns-chip" title="${esc(x.path || x.label)}"><span>${esc(x.label)}</span><button aria-label="Remove ${esc(x.label)}">${ICON.x}</button></span>`);
      $('button', c).onclick = () => { picked.delete(k); draw(); drawVids(); };
      return c;
    }));
  };
  $('#nsLinks', d).oninput = draw;
  const addFiles = (list) => { for (const f of list) if (/^video\//.test(f.type) || /\.(mp4|mov|m4v|webm)$/i.test(f.name)) picked.set(`f:${f.name}:${f.size}`, { kind: 'file', label: f.name, file: f }); draw(); };
  $('[data-a=choose]', d).onclick = () => $('#nsFile', d).click();
  $('#nsFile', d).onchange = (e) => addFiles(e.target.files);
  const drop = $('#nsDrop', d);
  drop.ondragover = (e) => { e.preventDefault(); drop.classList.add('over'); };
  drop.ondragleave = () => drop.classList.remove('over');
  drop.ondrop = (e) => { e.preventDefault(); drop.classList.remove('over'); addFiles(e.dataTransfer.files); };
  let vids = [];
  const drawVids = () => {
    $('#nsVids', d).replaceChildren(...vids.map((v) => {
      const k = `p:${v.rel}`;
      const row = h(`<label class="ns-vid"><input type="checkbox" aria-label="Use ${esc(v.rel)} as a sample"${picked.has(k) ? ' checked' : ''}><span class="ns-vt"><b>${esc(v.rel.split('/').pop())}</b><small>${esc(v.rel.split('/').slice(0, -1).join('/'))} · ${mb(v.bytes)} · ${ago(v.at)}</small></span></label>`);
      $('input', row).onchange = (e) => { if (e.target.checked) picked.set(k, { kind: 'path', label: v.rel.split('/').pop(), path: v.rel }); else picked.delete(k); draw(); };
      return row;
    }));
    if (!vids.length) $('#nsVids', d).append(h(`<div class="sub" style="padding:10px 12px">No videos found.</div>`));
  };
  let qTimer;
  const search = async () => { try { vids = await api(`/api/library/videos?q=${encodeURIComponent($('#nsQ', d).value)}`); } catch { vids = []; } drawVids(); };
  $('#nsQ', d).oninput = () => { clearTimeout(qTimer); qTimer = setTimeout(search, 200); };
  search();
  draw();
  setTimeout(() => $('#nsName', d).focus(), 30);
  $('[data-a=go]', d).onclick = async () => {
    const name = $('#nsName', d).value.trim();
    if (!name) return $('#nsName', d).focus();
    const go = $('[data-a=go]', d), msg = $('#nsMsg', d);
    go.disabled = true;
    try {
      const { slug } = await api('/api/library/style-new', { name });
      const files = [...picked.values()].filter((x) => x.kind === 'file');
      for (const [i, x] of files.entries()) {
        await uploadFile(x.file, { kind: 'samples', style: slug }, (p) => { msg.textContent = `Copying ${i + 1} of ${files.length}: ${Math.round(p * 100)}%`; });
      }
      msg.textContent = 'Asking Claude…';
      await api('/api/library/style-make', { slug, paths: [...picked.values()].filter((x) => x.kind === 'path').map((x) => x.path), links: links() });
      close();
      toast(`Claude is studying the samples for "${slug}". Follow along in the Library assistant.`);
      onStarted?.(slug);
    } catch (e) { msg.textContent = ''; toast(e.message); go.disabled = false; }
  };
}

// ---------- the Library's Claude (side panel) ----------
function makeMiniChat(box, onFiles) {
  box.replaceChildren(h(`<div class="lib-chat">
    <div class="rc-head"><b>Library assistant</b><span class="gap"></span><span class="sub" id="lcState"></span></div>
    <p class="sub">Claude for the library: styles from samples, finding and making sounds. Your own Claude Code, like in projects.</p>
    <div class="lc-msgs" id="lcMsgs"><div class="sub lc-empty">Nothing yet. Make a style or find a sound, or ask here.</div></div>
    <div class="composer"><label class="vh" for="lcIn">Message the Library assistant</label><textarea id="lcIn" rows="1" placeholder="Ask about the library…"></textarea>
      <button class="send" id="lcSend" aria-label="Send"><span class="l-send"><svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true"><path d="M7 12V2M3 6l4-4 4 4"/></svg></span><i class="stop-sq l-stop" aria-hidden="true"></i></button></div></div>`));
  const msgs = $('#lcMsgs', box), input = $('#lcIn', box), sendBtn = $('#lcSend', box);
  const cards = new Map(), tools = new Map();
  let busy = false;
  const add = (n) => { $('.lc-empty', msgs)?.remove(); const stick = msgs.scrollHeight - msgs.scrollTop - msgs.clientHeight < 80; msgs.append(n); if (stick) msgs.scrollTop = msgs.scrollHeight; return n; };
  const setBusy = (b) => { busy = b; $('#lcState', box).innerHTML = b ? '<span class="spin" style="display:inline-block;vertical-align:-2px"></span> working' : ''; sendBtn.classList.toggle('is-stop', b); sendBtn.setAttribute('aria-label', b ? 'Stop' : 'Send'); };
  sendBtn.onclick = async () => {
    if (busy) return api('/api/library/stop', {});
    const t = input.value.trim(); if (!t) return;
    input.value = '';
    try { await api('/api/library/chat', { text: t }); } catch (e) { toast(e.message); }
  };
  input.onkeydown = (e) => { if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); if (!busy) sendBtn.onclick(); } };
  const closeCard = (card, label) => { if (!card || card.classList.contains('closed')) return; card.classList.add('closed'); card.querySelectorAll('.row').forEach((r) => r.remove()); card.append(h(`<div class="sub" style="margin-top:6px">${esc(label)}</div>`)); };
  const answer = (cid, payload, card) => api('/api/library/answer', { id: cid, ...payload }).catch((e) => { toast(e.message); closeCard(card, 'No longer waiting'); });
  function handle(ev) {
    switch (ev.t) {
      case 'files': onFiles(); break;
      case 'busy': setBusy(ev.busy); break;
      case 'user': add(h(`<div class="msg-user">${esc(ev.text.length > 400 ? ev.text.slice(0, 400) + '…' : ev.text)}</div>`)); break;
      case 'text': add(h(`<div class="msg-ai">${mdLite(ev.text)}</div>`)); break;
      case 'tool': { const n = add(h(`<div class="tool"><b>${esc(ev.name)}</b> ${esc(ev.summary)}</div>`)); tools.set(ev.id, n); n.onclick = () => n.querySelector('pre')?.toggleAttribute('hidden'); break; }
      case 'tool_result': { const n = tools.get(ev.id); if (n && ev.text) { n.append(h(`<pre hidden>${esc(ev.text)}</pre>`)); if (ev.error) n.classList.add('err'); } break; }
      case 'permission': {
        const card = add(h(`<div class="ask"><div class="q">${esc(window.STUDIO_AGENT || 'Claude')} wants to use ${esc(ev.tool)}</div><div>${esc(ev.description || ev.summary)}</div>${ev.detail ? `<pre>${esc(ev.detail)}</pre>` : ''}
          <div class="row"><button class="btn primary small" data-a="1">Allow</button><button class="btn small" data-a="0">Deny</button></div></div>`));
        cards.set(ev.id, card);
        if (ev.expired) closeCard(card, 'Not answered');
        else card.querySelectorAll('[data-a]').forEach((b) => (b.onclick = () => answer(ev.id, { allow: b.dataset.a === '1' }, card)));
        break;
      }
      case 'question': {
        const card = add(h(`<div class="ask"></div>`)); cards.set(ev.id, card);
        const answers = {};
        ev.questions.forEach((q) => {
          card.append(h(`<div class="q">${esc(q.question)}</div>`));
          const row = h(`<div class="row"></div>`);
          q.options.forEach((o) => { const b = h(`<button class="btn small">${esc(o.label)}</button>`); b.onclick = () => { answers[q.question] = o.label; b.classList.add('primary'); if (Object.keys(answers).length === ev.questions.length) answer(ev.id, { answers }, card); }; row.append(b); });
          card.append(row);
        });
        if (ev.expired) closeCard(card, 'Not answered');
        break;
      }
      case 'permission_done': closeCard(cards.get(ev.id), { allowed: 'Allowed', denied: 'Denied', answered: 'Answered', withdrawn: 'No longer needed' }[ev.outcome] || ev.outcome); break;
      case 'result': add(h(`<div class="divider">${ev.ok ? 'done' : 'stopped'}${ev.seconds ? ` · ${ev.seconds} s` : ''}</div>`)); if (!ev.replay) onFiles(); break;
      case 'error': add(h(`<div class="error">${esc(ev.text)}</div>`)); break;
      case 'note': add(h(`<div class="note">${esc(ev.text)}</div>`)); break;
    }
  }
  const es = new EventSource('/api/library/events');
  es.onmessage = (m) => handle(JSON.parse(m.data));
  return { close: () => es.close() };
}

// ---------- the Library page ----------
const SECTION_ORDER = ['styles', 'sfx', 'backgrounds', 'components', 'broll', 'stills'];

export function renderLibrary(main, side) {
  let L = null, I = null, freeQ = '', soundQ = '', loading = false, again = false;
  const chat = makeMiniChat(side, () => load());
  main.replaceChildren(h(`<div class="home-wrap lib">
    <div class="home-head"><div class="hh-title"><h1>Library</h1><div class="sub mono" id="libDir"></div></div>
      <span class="gap"></span><button class="btn" id="libFolders">${ICON.folder}Folders</button><button class="btn" id="libReveal">Show in ${fileManager()}</button></div>
    <p class="sub lead">Reusable pieces for every project. Claude reads the same folders: each has an INDEX.md with one line per file.</p>
    <nav class="seg lib-jump" aria-label="Jump to"></nav>
    <div id="libBody"></div></div>`));
  $('#libReveal', main).onclick = () => api('/api/library/reveal', { file: '.' });
  $('#libFolders', main).onclick = () => foldersDialog(L, load);

  async function load() {
    if (loading) { again = true; return; }
    loading = true;
    try { [L, I] = await Promise.all([api('/api/library'), api('/api/library/inbox').catch(() => null)]); draw(); } catch (e) { toast(e.message); }
    loading = false;
    if (again) { again = false; load(); }
  }

  function draw() {
    $('#libDir', main).textContent = tilde(L.dir);
    const kinds = SECTION_ORDER.map((k) => L.kinds.find((x) => x.key === k)).filter(Boolean);
    const inbox = I?.items?.length ? [{ key: 'inbox', label: 'Inbox', items: I.items }] : [];
    $('.lib-jump', main).replaceChildren(...[...inbox, ...kinds].map((k) => {
      const b = h(`<button${k.key === 'inbox' ? ' class="lj-inbox"' : ''}>${esc(k.label)} <span class="count">${k.items.length || ''}</span></button>`);
      b.onclick = () => document.getElementById(`lib-${k.key}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
      return b;
    }));
    const body = $('#libBody', main);
    const open = document.activeElement;
    const keep = open && body.contains(open) && open.id ? { id: open.id, pos: open.selectionStart } : null;
    body.replaceChildren(...(inbox.length ? [inboxSection()] : []), ...kinds.map((k) => section(k)));
    if (keep) { const el = document.getElementById(keep.id); if (el) { el.focus(); try { el.setSelectionRange(keep.pos, keep.pos); } catch {} } }
  }

  // The inbox: what Claude proposed for the library (scheduled runs in "ask before changes" mode, the Video Octopus
  // assistant), waiting for the creator: add it to a section, or put it aside (kept in inbox/.aside).
  function inboxSection() {
    const sec = h(`<section class="lib-sec lib-inbox" id="lib-inbox"><div class="lib-sec-head"><h2>Inbox</h2><span class="sub">${I.items.length} waiting for your OK</span><span class="gap"></span>
      <button class="btn small ghost" data-a="reveal">Show in ${fileManager()}</button></div>
      <p class="sub">Pieces Claude proposed for the library. Add one to a section, or put it aside (it moves to inbox/.aside, nothing is deleted).</p>
      <div class="inbox-list"></div></section>`);
    $('[data-a=reveal]', sec).onclick = () => api('/api/library/reveal', { file: 'inbox' }).catch((e) => toast(e.message));
    const list = $('.inbox-list', sec);
    for (const it of I.items) {
      const files = it.files.filter((f) => !/^readme\.(md|txt)$/i.test(f.split('/').pop()));
      const card = h(`<div class="inbox-card">
        <div class="ic-top"><b>${esc(it.name)}</b><span class="sub">${it.from ? `from ${esc(it.from)} · ` : ''}${esc(ago(it.at))}</span></div>
        ${it.summary ? `<p class="ic-sum">${esc(it.summary)}</p>` : ''}
        <div class="ic-files sub mono">${files.slice(0, 6).map(esc).join(' · ')}${files.length > 6 ? ` · ${files.length - 6} more` : ''}${files.length ? '' : 'no files yet, only a note'}</div>
        ${it.readme ? `<details class="ic-readme"><summary>Claude's note</summary><div class="md">${mdLite(it.readme)}</div></details>` : ''}
        <div class="ic-acts"><label class="sub">Add to</label><select class="field small" aria-label="Library section">${I.kinds.map((k) => `<option value="${k.key}"${k.key === it.kind ? ' selected' : ''}>${esc(k.label)}</option>`).join('')}</select>
          <button class="btn small dark" data-a="ok"${files.length || it.folder ? '' : ' disabled'}>Add to library</button><button class="btn small ghost" data-a="aside">Put aside</button></div>
      </div>`);
      $('[data-a=ok]', card).onclick = async () => {
        try { const r = await api('/api/library/inbox/accept', { id: it.id, kind: $('select', card).value }); toast(`Added to the library: ${(r.files || [r.file]).join(', ')}`); load(); } catch (e) { toast(e.message); }
      };
      $('[data-a=aside]', card).onclick = async () => { try { await api('/api/library/inbox/aside', { id: it.id }); load(); } catch (e) { toast(e.message); } };
      list.append(card);
    }
    return sec;
  }

  function section(k) {
    const sec = h(`<section class="lib-sec" id="lib-${k.key}"><div class="lib-sec-head"><h2>${esc(k.label)}</h2><span class="sub">${k.items.length || 'empty'}</span><span class="gap"></span></div>
      <p class="sub">${esc(k.about)}</p><div class="lib-sec-body"></div></section>`);
    const head = $('.lib-sec-head', sec), body = $('.lib-sec-body', sec);
    // Drop files on a section to add them (on Styles: start a new style with them).
    sec.ondragover = (e) => { if (e.dataTransfer?.types?.includes('Files')) { e.preventDefault(); sec.classList.add('over'); } };
    sec.ondragleave = (e) => { if (!sec.contains(e.relatedTarget)) sec.classList.remove('over'); };
    sec.ondrop = (e) => { e.preventDefault(); sec.classList.remove('over'); const files = [...(e.dataTransfer?.files || [])]; if (!files.length) return; if (k.key === 'styles') newStyleDialog({ files, onStarted: load }); else addFiles(k.key, files); };
    if (k.key === 'styles') {
      const nb = h(`<button class="btn accent small">New style from samples</button>`);
      nb.onclick = () => newStyleDialog({ onStarted: load });
      head.append(nb);
      const cards = h(`<div class="lib-styles"></div>`);
      for (const s of L.pendingStyles) cards.append(h(`<div class="style-card pending"><b>${esc(s.name)}</b><span class="sub"><span class="spin" style="display:inline-block;vertical-align:-2px"></span> Claude is studying ${(s.samples || []).length} samples…</span></div>`));
      for (const it of k.items) {
        const c = h(`<button class="style-card"><b>${esc(it.name)}</b><span class="sub">${esc(it.note || 'No summary yet')}</span><span class="sc-meta">${it.samples ? `${it.samples} samples · ` : ''}${ago(it.at)}</span></button>`);
        c.onclick = () => viewStyle(it);
        cards.append(c);
      }
      if (!k.items.length && !L.pendingStyles.length) cards.append(h(`<div class="empty small"><b>No styles yet</b><span class="sub">Make one from 3–10 sample shorts, or drop videos here.</span></div>`));
      body.append(cards);
      return sec;
    }
    if (k.key === 'sfx') { soundsBody(head, body, k); return sec; }
    const add = h(`<label class="btn small">Add files<input type="file" multiple hidden></label>`);
    $('input', add).onchange = (e) => addFiles(k.key, [...e.target.files]);
    head.append(add);
    const grid = h(`<div class="lib-grid"></div>`);
    for (const it of k.items) grid.append(tile(it));
    if (!k.items.length) grid.append(h(`<div class="empty small"><span class="sub">Nothing here yet. Use “Save to library” on a render, or drop files here.</span></div>`));
    body.append(grid);
    return sec;
  }

  function tile(it) {
    const url = libUrl(it.file);
    const prev = it.type === 'image' ? `<img alt="" loading="lazy" src="${url}">`
      : it.type === 'video' ? `<video muted loop playsinline preload="metadata" src="${url}#t=0.5"></video>`
      : it.type === 'html' || it.preview ? `<iframe title="${esc(it.name)}" loading="lazy" sandbox="allow-scripts" src="${libUrl(it.preview || it.file)}"></iframe>`
      : `<span class="lt-kind">${esc(it.type === 'folder' ? 'folder' : (it.name.split('.').pop() || '').toUpperCase())}</span>`;
    const t = h(`<div class="lib-tile"><div class="lt-prev">${prev}</div><div class="lt-name" title="${esc(it.file)}">${esc(it.name)}</div><div class="sub lt-note">${esc(it.note || '')}</div></div>`);
    const v = $('video', t);
    if (v) { t.onmouseenter = () => v.play().catch(() => {}); t.onmouseleave = () => v.pause(); }
    t.ondblclick = () => api('/api/library/reveal', { file: it.file });
    return t;
  }

  function soundsBody(head, body, k) {
    const add = h(`<label class="btn small">Add files<input type="file" accept="audio/*" multiple hidden></label>`);
    $('input', add).onchange = (e) => addFiles('sfx', [...e.target.files]);
    head.append(add);
    const find = h(`<form class="find-row"><input class="field" id="libFind" placeholder="Find a sound: a soft whoosh for a page turn…" autocomplete="off"><button class="btn dark">Find with Claude</button></form>`);
    find.onsubmit = async (e) => {
      e.preventDefault();
      const q = $('input', find).value.trim();
      if (!q) return;
      try { await api('/api/library/sound-find', { query: q }); $('input', find).value = ''; toast('Claude is looking. New sounds show up under “Waiting for you”.'); } catch (err) { toast(err.message); }
    };
    body.append(find);
    if (L.candidates.length) {
      const w = h(`<div class="snd-group"><h4>Waiting for you <span class="sub">${L.candidates.length}</span></h4><div class="snd-rows"></div></div>`);
      for (const c of L.candidates) $('.snd-rows', w).append(candidateRow(c, load));
      body.append(w);
    }
    const lib = h(`<div class="snd-group"><h4>In the library</h4><input class="field small snd-q" id="libSndQ" type="search" placeholder="Filter sounds" value="${esc(soundQ)}"><div class="snd-rows"></div></div>`);
    const rows = $('.snd-rows', lib);
    const fill = () => {
      const q = soundQ.toLowerCase();
      const list = k.items.filter((it) => !q || `${it.name} ${it.note}`.toLowerCase().includes(q));
      rows.replaceChildren(...list.map((it) => soundRow(it)));
      if (!list.length) rows.append(h(`<div class="sub snd-none">${k.items.length ? 'No sound matches.' : 'No sounds yet. Find one with Claude, add files, or pick from the free folder below.'}</div>`));
    };
    $('.snd-q', lib).oninput = (e) => { soundQ = e.target.value; fill(); };
    fill();
    body.append(lib);
    const free = h(`<div class="snd-group"><h4>Free sound folder</h4></div>`);
    if (!L.settings.sfxFreeDir) {
      free.append(h(`<p class="sub">Point Video Octopus at a folder of free sounds (a CC0 pack, for example) under Folders, and browse it here.</p>`));
    } else {
      free.append(h(`<p class="sub mono">${esc(tilde(L.settings.sfxFreeDir))}</p>`));
      const fq = h(`<input class="field small snd-q" id="libFreeQ" type="search" placeholder="Search the free folder: click, impact, swoosh…" value="${esc(freeQ)}">`);
      const frows = h(`<div class="snd-rows"></div>`);
      let ft;
      const search = async () => {
        let r = { items: [] };
        try { r = await api(`/api/library/free?q=${encodeURIComponent(freeQ)}`); } catch {}
        frows.replaceChildren(...r.items.slice(0, 40).map((x) => freeRow(x, load)));
        if (!r.items.length) frows.append(h(`<div class="sub snd-none">Nothing found.</div>`));
      };
      fq.oninput = () => { freeQ = fq.value; clearTimeout(ft); ft = setTimeout(search, 200); };
      free.append(fq, frows);
      search();
    }
    body.append(free);
  }

  async function addFiles(kind, files) {
    for (const [i, f] of files.entries()) {
      try { await uploadFile(f, { kind }, (p) => toast(`Adding ${f.name} (${i + 1} of ${files.length}): ${Math.round(p * 100)}%`)); }
      catch (e) { toast(e.message); return; }
    }
    toast(`Added ${files.length} file${files.length > 1 ? 's' : ''} to the library.`);
    load();
  }

  function viewStyle(it) {
    const modal = $('#modal');
    const d = h(`<div class="dialog np style-view" role="dialog" aria-modal="true" aria-label="Style ${esc(it.name)}">
      <div class="np-head"><div><h3>${esc(it.name)}</h3><div class="sub mono">${esc(it.file)}</div></div><button class="btn ghost small np-x" aria-label="Close">${ICON.x}</button></div>
      <div class="style-md">Loading…</div>
      <div class="actions"><button class="btn" data-a="reveal">Show in ${fileManager()}</button><button class="btn primary" data-a="x">Close</button></div></div>`);
    modal.replaceChildren(d); modal.hidden = false;
    const close = () => { modal.hidden = true; };
    $('.np-x', d).onclick = close; $('[data-a=x]', d).onclick = close;
    modal.onclick = (e) => { if (e.target === modal) close(); };
    $('[data-a=reveal]', d).onclick = () => api('/api/library/reveal', { file: it.file });
    fetch(libUrl(it.file)).then((r) => r.text()).then((t) => { $('.style-md', d).innerHTML = mdLite(t); }).catch(() => { $('.style-md', d).textContent = 'Couldn’t read the style.'; });
  }

  load();
  if (/new-style/.test(location.hash)) setTimeout(() => newStyleDialog({ onStarted: load }), 50);
  return { teardown: () => { chat.close(); stopPreview(); } };
}

export function soundRow(it, extra) {
  const row = h(`<div class="snd-row"><span class="snd-n"><b>${esc(it.name)}</b><small>${esc(it.note || '')}</small></span><span class="snd-d sub"></span></div>`);
  row.prepend(playButton(libUrl(it.file), `Play ${it.name}`));
  const a = new Audio(); a.preload = 'metadata'; a.src = libUrl(it.file);
  a.onloadedmetadata = () => { $('.snd-d', row).textContent = `${a.duration.toFixed(1)} s`; };
  if (extra) row.append(extra);
  return row;
}

export function candidateRow(c, after) {
  const acts = h(`<span class="snd-acts"><button class="btn small dark" data-a="ok">Approve</button><button class="btn ghost small" data-a="no">Discard</button></span>`);
  const row = soundRow({ ...c, note: [c.note, c.source, c.licence && `licence: ${c.licence}`].filter(Boolean).join(' · ') }, acts);
  row.classList.add('cand');
  $('[data-a=ok]', acts).onclick = async () => { try { const r = await api('/api/library/sound-approve', { file: c.file }); toast(`Approved: ${r.file}`); after?.(r); } catch (e) { toast(e.message); } };
  $('[data-a=no]', acts).onclick = async () => { if (!confirm(`Discard ${c.name}?`)) return; try { await api('/api/library/sound-discard', { file: c.file }); after?.(); } catch (e) { toast(e.message); } };
  return row;
}

export function freeRow(x, after) {
  const row = h(`<div class="snd-row"><span class="snd-n"><b>${esc(x.name)}</b><small>${esc(x.file.split('/').slice(0, -1).join('/'))}</small></span><span class="snd-acts"><button class="btn small">Add to library</button></span></div>`);
  row.prepend(playButton(freeUrl(x.file), `Play ${x.name}`));
  $('button.btn', row).onclick = async () => { try { const r = await api('/api/library/sound-free-add', { file: x.file }); toast(`Added ${r.file}`); after?.(r); } catch (e) { toast(e.message); } };
  return row;
}

function foldersDialog(L, after) {
  const modal = $('#modal');
  const d = h(`<div class="dialog" role="dialog" aria-modal="true" aria-labelledby="lfT"><h3 id="lfT">Library folders</h3>
    <label class="fl" for="lfLib">Library folder</label><input class="field" id="lfLib" placeholder="${esc(tilde(L?.settings.defaultDir || ''))}" value="${esc(L?.settings.libraryDir || '')}">
    <p class="sub">Empty uses ${esc(tilde(L?.settings.defaultDir || 'library/ in your studio'))}.</p>
    <label class="fl" for="lfFree">Free sound folder</label><input class="field" id="lfFree" placeholder="~/Sounds/free-sfx" value="${esc(L?.settings.sfxFreeDir || '')}">
    <p class="sub">A folder of sounds you may use (for example a CC0 pack). Video Octopus and Claude search it by file name and copy what you pick into the library.</p>
    <div class="actions"><button class="btn ghost" data-a="x">Cancel</button><button class="btn primary" data-a="go">Save</button></div></div>`);
  modal.replaceChildren(d); modal.hidden = false;
  const close = () => { modal.hidden = true; };
  $('[data-a=x]', d).onclick = close;
  $('[data-a=go]', d).onclick = async () => {
    try { await api('/api/library/settings', { libraryDir: $('#lfLib', d).value.trim(), sfxFreeDir: $('#lfFree', d).value.trim() }); close(); after(); }
    catch (e) { toast(e.message); }
  };
}
