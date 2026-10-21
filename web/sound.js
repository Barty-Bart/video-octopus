// Sound on the canvas: the project's sound cues (work/sfx.json) in the inspector, a picker of library
// sounds to place at the playhead, sounds waiting for approval, "Find a sound" (asks the project's Claude),
// and the cues heard while the canvas plays. The timeline draws the cues in a Sound lane (drag to move).
import { $, esc, h, api, toast, clock } from './ui.js';
import { libUrl, playButton, stopPreview, soundRow, candidateRow, freeRow, styleSection } from './library.js';

export function makeSound({ host, id, getP, media, history }) {
  const url = `/api/projects/${encodeURIComponent(id)}`;
  let data = { cues: [], sounds: [], candidates: [], free: false }, sel = null, raf = 0, last = null, labelAt = 0, sig = '';
  let waitingFind = 0, poll = 0, dlg = null;
  const durs = new Map(), players = new Map();
  const srcOf = (c) => (c.from === 'project' ? `${url}/media?f=${encodeURIComponent(c.file)}` : libUrl(c.file));
  const now = () => media()?.currentTime || 0;

  // The level each sound file plays at in the preview, from the server (GET /sound: mix, the dB the export gives the cue,
  // Settings → Sound's level under the voice): kept per file without the cue's own gain, so a cue moved or re-levelled
  // here keeps it.
  const bases = new Map();
  async function load() {
    try { data = await api(`${url}/sound`); } catch { return; }
    for (const c of data.cues) { duration(c); if (Number.isFinite(c.mix)) bases.set(c.file, c.mix - c.gain); }
    render();
    if (dlg) dlg.refresh();
  }
  function duration(c) {
    const src = srcOf(c);
    if (durs.has(src) || c.missing) return; // a missing file: nothing to load (no 404 in the console)
    durs.set(src, 0.6);
    const a = new Audio(); a.preload = 'metadata'; a.src = src;
    a.onloadedmetadata = () => durs.set(src, a.duration || 0.6);
  }

  function render() {
    const s = JSON.stringify([data.cues, sel, getP().kit?.style, getP().type]);
    if (s === sig && host.firstChild) return label();
    sig = s;
    const box = h(`<div class="ins-body kit-ins">
      <div class="kit-style-host"></div>
      <section class="snd"><h3>Sound <span class="sub">${data.cues.length ? `${data.cues.length} cue${data.cues.length > 1 ? 's' : ''}` : ''}</span></h3>
        <div class="cue-list"></div>
        <button class="btn wide" id="addSnd">+ Sound at <span id="addAt">0:00.0</span></button>
        <p class="sub" style="margin-top:8px">Effects sit about ${Number.isFinite(data.under) ? data.under : 18} dB under your voice (Settings → Sound), here and in the export. Drag a cue on the timeline to move it.</p></section></div>`);
    const list = $('.cue-list', box);
    for (const c of data.cues) list.append(cueRow(c));
    if (!data.cues.length) list.append(h(`<p class="sub">No sounds yet. Move the playhead to a moment and add one from your library.</p>`));
    $('#addSnd', box).onclick = () => picker();
    host.replaceChildren(box);
    styleSection($('.kit-style-host', box), { id, getP });
    label();
  }
  function label() { const el = $('#addAt', host); if (el) el.textContent = clock(now()); }

  function cueRow(c) {
    const on = c.id === sel;
    const row = h(`<div class="cue${on ? ' on' : ''}">
      <div class="cue-top"><span class="cue-t">${clock(c.t)}</span><span class="cue-n" title="${esc(c.missing ? `${c.file} is missing` : c.file)}">${esc(c.label)}${c.missing ? ' <span class="sub">· file missing</span>' : ''}</span>
        <span class="cue-g">${c.gain ? `${c.gain > 0 ? '+' : ''}${c.gain} dB` : ''}</span><button class="btn ghost small cue-x" aria-label="Remove ${esc(c.label)}">${'×'}</button></div>
      ${on ? `<div class="cue-more"><label class="slider"><span>Level</span><input type="range" min="-12" max="6" step="1" value="${c.gain}" aria-label="Level"><span class="val">${c.gain > 0 ? '+' : ''}${c.gain} dB</span></label>
        <div class="two"><button class="btn small" data-a="nudge-">◀ 0.1 s</button><button class="btn small" data-a="nudge+">0.1 s ▶</button></div>
        <div class="two"><button class="btn small" data-a="here">Move to playhead</button><button class="btn small" data-a="go">Go to it</button></div></div>` : ''}</div>`);
    if (!c.missing) row.prepend(playButton(srcOf(c), `Play ${c.label}`));
    $('.cue-top', row).onclick = (e) => { if (e.target.closest('button')) return; pick(on ? null : c.id); if (!on) seek(c.t - 0.5); };
    $('.cue-x', row).onclick = () => op({ op: 'remove', id: c.id });
    if (on) {
      const r = $('input[type=range]', row);
      r.oninput = () => { $('.slider .val', row).textContent = `${r.value > 0 ? '+' : ''}${r.value} dB`; };
      r.onchange = () => op({ op: 'update', id: c.id, gain: Number(r.value) });
      $('[data-a="nudge-"]', row).onclick = () => op({ op: 'update', id: c.id, t: Math.max(0, c.t - 0.1) });
      $('[data-a="nudge+"]', row).onclick = () => op({ op: 'update', id: c.id, t: c.t + 0.1 });
      $('[data-a=here]', row).onclick = () => op({ op: 'update', id: c.id, t: now() });
      $('[data-a=go]', row).onclick = () => seek(c.t - 0.5);
    }
    return row;
  }

  function seek(t) { const m = media(); if (m) m.currentTime = Math.max(0, t); }
  function pick(cid) { sel = cid; render(); }

  async function op(b) {
    try {
      const r = await api(`${url}/sfx`, b);
      data.cues = r.cues;
      if (b.op === 'add') sel = r.id;
      if (b.op === 'remove' && sel === b.id) sel = null;
      for (const c of data.cues) duration(c);
      render();
      if (b.op === 'add' && !bases.has(data.cues.find((c) => c.id === r.id)?.file)) load(); // a new sound: its level
      return r;
    } catch (e) { toast(e.message); }
  }

  // ---- the sound picker: library sounds to place, sounds waiting for approval, the free folder, Find ----
  function picker() {
    const at = now();
    media()?.pause();
    const modal = $('#modal');
    let tab = data.candidates.length && waitingFind ? 'wait' : 'lib', q = '';
    const d = h(`<div class="dialog np snd-dlg" role="dialog" aria-modal="true" aria-labelledby="sdT">
      <div class="np-head"><div><h3 id="sdT">Add a sound at ${clock(at)}</h3><div class="sub">From your library. It plays in the canvas and goes into the export, under your voice.</div></div>
        <button class="btn ghost small np-x" data-a="x" aria-label="Close">×</button></div>
      <div class="sd-bar"><div class="seg" role="tablist"><button data-t="lib">Library <span class="count" id="sdN1"></span></button><button data-t="wait">Waiting for you <span class="count" id="sdN2"></span></button>${data.free ? '<button data-t="free">Free folder</button>' : ''}</div>
        <input class="field small" type="search" id="sdQ" placeholder="Filter" autocomplete="off"></div>
      <div class="snd-rows sd-list" id="sdList"></div>
      <form class="find-row" id="sdFind"><input class="field" placeholder="Find a sound: a soft whoosh into the split screen…" autocomplete="off"><button class="btn dark">Find or make a sound</button></form>
      <p class="sub" id="sdFindNote">Claude makes it in code, searches Epidemic Sound if it's connected, or picks from your free sound folder. New sounds wait here until you approve them.</p></div>`);
    modal.replaceChildren(d); modal.hidden = false;
    const close = () => { modal.hidden = true; dlg = null; clearInterval(poll); stopPreview(); document.removeEventListener('keydown', onEsc); };
    const onEsc = (e) => { if (e.key === 'Escape') close(); };
    document.addEventListener('keydown', onEsc);
    d.querySelectorAll('[data-a=x]').forEach((b) => (b.onclick = close));
    modal.onclick = (e) => { if (e.target === modal) close(); };
    let freeT;
    const fill = async () => {
      $('#sdN1', d).textContent = data.sounds.length || '';
      $('#sdN2', d).textContent = data.candidates.length || '';
      d.querySelectorAll('[data-t]').forEach((b) => { b.classList.toggle('on', b.dataset.t === tab); b.setAttribute('aria-selected', String(b.dataset.t === tab)); });
      const list = $('#sdList', d), term = q.toLowerCase();
      const match = (x) => !term || `${x.name} ${x.note || ''}`.toLowerCase().includes(term);
      if (tab === 'lib') {
        const items = data.sounds.filter(match);
        list.replaceChildren(...items.map((it) => {
          const place = h(`<span class="snd-acts"><button class="btn small dark">Place at ${clock(at)}</button></span>`);
          $('button', place).onclick = async () => {
            const r = await op({ op: 'add', file: it.file, from: 'library', t: at, label: it.name.replace(/\.[^.]+$/, '') });
            if (r) { close(); toast(`Placed ${it.name} at ${clock(at)}.`); }
          };
          return soundRow(it, place);
        }));
        if (!items.length) list.append(h(`<div class="sub snd-none">${data.sounds.length ? 'No sound matches.' : 'Your library has no sounds yet. Find one with Claude below, or approve one under “Waiting for you”.'}</div>`));
      } else if (tab === 'wait') {
        const items = data.candidates.filter(match);
        list.replaceChildren(...items.map((c) => candidateRow(c, async (r) => {
          await load();
          if (r?.file) { tab = 'lib'; fill(); toast(`Approved ${r.file.split('/').pop()}. Place it from the library.`); }
        })));
        if (!items.length) list.append(h(`<div class="sub snd-none">${waitingFind ? '<span class="spin" style="display:inline-block;vertical-align:-2px"></span> Claude is looking for sounds…' : 'Nothing waiting. Ask Claude below.'}</div>`));
      } else {
        clearTimeout(freeT);
        freeT = setTimeout(async () => {
          let r = { items: [] };
          try { r = await api(`/api/library/free?q=${encodeURIComponent(q)}`); } catch {}
          list.replaceChildren(...r.items.slice(0, 50).map((x) => freeRow(x, async () => { await load(); })));
          if (!r.items.length) list.append(h(`<div class="sub snd-none">Nothing found.</div>`));
        }, 150);
      }
    };
    d.querySelectorAll('[data-t]').forEach((b) => (b.onclick = () => { tab = b.dataset.t; fill(); }));
    $('#sdQ', d).oninput = (e) => { q = e.target.value; fill(); };
    $('#sdFind', d).onsubmit = async (e) => {
      e.preventDefault();
      const text = $('input', e.target).value.trim();
      if (!text) return;
      try {
        await api(`${url}/sound-find`, { query: text, at });
        waitingFind = Date.now(); tab = 'wait'; $('input', e.target).value = '';
        $('#sdFindNote', d).textContent = 'Claude is on it (watch the chat). The options show up here; keep this open or come back later.';
        fill(); startPoll();
      } catch (err) { toast(err.message); }
    };
    // While Claude looks, check for new sounds every few seconds.
    const startPoll = () => {
      clearInterval(poll);
      poll = setInterval(async () => {
        if (Date.now() - waitingFind > 15 * 60e3) { waitingFind = 0; clearInterval(poll); }
        try {
          const c = await api('/api/library/candidates');
          if (JSON.stringify(c.map((x) => x.file + x.note)) !== JSON.stringify(data.candidates.map((x) => x.file + x.note))) { data.candidates = c; fill(); }
        } catch {}
      }, 2500);
    };
    if (waitingFind) startPoll();
    dlg = { refresh: fill };
    fill();
    setTimeout(() => $('#sdQ', d).focus(), 30);
  }

  // ---- hear the cues while the canvas plays (the export mixes them properly) ----
  function loop() {
    raf = requestAnimationFrame(loop);
    const m = media();
    if (!m) { last = null; return; }
    const t = m.currentTime;
    if (!m.paused && !muted && last != null && t > last && t - last < 0.5) {
      for (const c of data.cues) if (c.t > last && c.t <= t) hear(c);
    }
    if (m.paused || t < (last ?? 0)) for (const a of players.values()) if (!a.paused && m.paused) a.pause();
    last = t;
    if (performance.now() - labelAt > 200) { labelAt = performance.now(); label(); }
  }
  function hear(c) {
    if (c.missing) return;
    const src = srcOf(c);
    let a = players.get(src);
    if (!a) { a = new Audio(src); players.set(src, a); }
    // The export's level: the take plays its voice as recorded, so the cue at the export's gain sits where the export puts it.
    const b = bases.get(c.file);
    const m = media(), vol = m ? (m.muted ? 0 : m.volume) : 1; // and the preview's own volume
    a.volume = Math.min(1, vol * (b != null ? 10 ** ((b + c.gain) / 20) : 0.45 * 10 ** (c.gain / 20)));
    a.currentTime = 0;
    a.play().catch(() => {});
  }
  raf = requestAnimationFrame(loop);

  // ---- edits from the timeline (web/timeline.js): several cues at once, each edit undoable; the lane's mute ----
  let muted = false;
  async function setAll(cues) { const r = await api(`${url}/sfx`, { op: 'set', cues }); data.cues = r.cues; render(); }
  async function edit(label, change) {
    const before = structuredClone(data.cues), after = change(structuredClone(data.cues));
    try { await setAll(after); history?.push({ label, undo: () => setAll(before), redo: () => setAll(after) }); } catch (e) { toast(e.message); }
  }
  const many = (n, one, more) => (n > 1 ? `${more.replace('N', n)}` : one);
  const cueEdits = {
    move: (list) => edit(many(list.length, 'Move a sound cue', 'Move N sound cues'), (cues) => { for (const m of list) { const c = cues.find((x) => x.id === m.id); if (c) c.t = m.t; } return cues; }),
    remove: (ids) => { if (ids.includes(sel)) sel = null; return edit(many(ids.length, 'Delete a sound cue', 'Delete N sound cues'), (cues) => cues.filter((c) => !ids.includes(c.id))); },
    // A copy lands right after the original (its length plus a beat). Returns the copies' ids.
    duplicate: async (ids) => {
      const made = [];
      await edit(many(ids.length, 'Duplicate a sound cue', 'Duplicate N sound cues'), (cues) => [...cues, ...cues.filter((c) => ids.includes(c.id))
        .map((c) => { const id = Math.random().toString(16).slice(2, 10); made.push(id); return { ...c, id, t: Math.round((c.t + (durs.get(srcOf(c)) || 0.6) + 0.1) * 100) / 100 }; })]);
      return made;
    },
  };

  return {
    cues: cueEdits, setMute: (on) => { muted = Boolean(on); if (muted) for (const a of players.values()) a.pause(); },
    update: () => load(),
    // For the timeline's Sound lane.
    timeline: () => data.cues.map((c) => ({ id: c.id, t: c.t, dur: durs.get(srcOf(c)) || 0.6, label: c.label, on: c.id === sel })),
    pick: (cid) => pick(cid),
    move: (cid, t) => op({ op: 'update', id: cid, t }),
    destroy: () => { cancelAnimationFrame(raf); clearInterval(poll); for (const a of players.values()) a.pause(); stopPreview(); },
  };
}
